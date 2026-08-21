import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DialogOutcome, QuestionDialog } from "./dialog.js";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_ID_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MAX_QUESTIONS,
  MAX_VALUE_LENGTH,
  normalizeQuestions,
  type Question,
  type QuestionAnswer,
  type QuestionSelection,
  sanitizeDisplayText,
} from "./normalize.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const OptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH, description: "Short user-facing option label." }),
    description: Type.Optional(
      Type.String({ maxLength: MAX_DESCRIPTION_LENGTH, description: "Optional explanation of the tradeoff." }),
    ),
    value: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_VALUE_LENGTH, description: "Optional machine-readable value." }),
    ),
  },
  { additionalProperties: false },
);

const QuestionSchema = Type.Object(
  {
    id: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, description: "Stable identifier for this answer." }),
    ),
    header: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_HEADER_LENGTH,
        description: "Short heading shown above the question.",
      }),
    ),
    question: Type.String({
      minLength: 1,
      maxLength: MAX_QUESTION_LENGTH,
      description: "The question to show the user.",
    }),
    options: Type.Array(OptionSchema, { minItems: 2, maxItems: MAX_OPTIONS, description: "Two to four choices." }),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "Allow multiple choices; the user explicitly chooses Done." }),
    ),
    allowOther: Type.Optional(Type.Boolean({ description: "Offer a free-text Other answer; defaults to true." })),
  },
  { additionalProperties: false },
);

export const ASK_USER_QUESTION_PARAMETERS = Type.Object(
  {
    questions: Type.Array(QuestionSchema, {
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: "One to four questions. Ask only related decisions in one batch.",
    }),
  },
  { additionalProperties: false },
);

export type CancellationReason = "cancelled" | "aborted" | "disposed" | "invalid_input" | "ui_unavailable" | "ui_error";

export interface AskUserQuestionDetails {
  version: 1;
  cancelled: boolean;
  questions: Question[];
  answers: QuestionAnswer[];
  reason?: CancellationReason;
  message?: string;
}

export interface AskUserQuestionResult {
  content: [{ type: "text"; text: string }];
  details: AskUserQuestionDetails;
}

const askUserQuestionTool = defineTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  label: "Ask user question",
  description:
    "Ask the user one to four focused decision questions with bounded choices. Use this when an important preference, tradeoff, or missing requirement cannot be discovered from the available context. Wait for the structured answer before continuing.",
  promptSnippet: "Ask the user focused decision questions and wait for structured answers",
  promptGuidelines: [
    "Use ask_user_question for decisions that materially affect the work, not for routine progress updates or questions answerable from the repository.",
    "Ask one to four related questions, provide two to four mutually exclusive options, and put the recommended option first when there is a clear default.",
    "Use multiSelect only when choices can be combined. Keep question and option text concise; use allowOther when a free-form answer is genuinely useful.",
    "The tool is sequential: wait for its result before making another user-facing decision request, and use the returned answer objects rather than inferring a choice.",
  ],
  parameters: ASK_USER_QUESTION_PARAMETERS,
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AskUserQuestionResult> {
    const normalized = normalizeQuestions(params);
    if (!normalized.ok) {
      return cancellation([], "invalid_input", normalized.error);
    }
    if (signal?.aborted) return cancellation(normalized.questions, "aborted", "The question request was aborted.");

    const outcome = await askQuestions(normalized.questions, ctx, signal);
    if (outcome.kind === "answered") return answered(normalized.questions, outcome.answers);
    return cancellation(normalized.questions, outcome.reason, cancelMessage(outcome.reason), outcome.answers);
  },
});

export default function askUserQuestion(pi: ExtensionAPI): void {
  pi.registerTool(askUserQuestionTool);
}

export { askUserQuestionTool };

async function askQuestions(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<DialogOutcome | { kind: "cancelled"; reason: CancellationReason; answers: QuestionAnswer[] }> {
  // RPC has UI request methods but cannot mount a local component. Print mode,
  // and contexts without UI, are deliberately cancellation-only.
  if (!ctx.hasUI) return { kind: "cancelled", reason: "ui_unavailable", answers: [] };
  if (ctx.mode === "tui") return askWithDialog(questions, ctx, signal);
  if (ctx.mode === "rpc") return askWithRpcFallback(questions, ctx, signal);
  return { kind: "cancelled", reason: "ui_unavailable", answers: [] };
}

async function askWithDialog(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<DialogOutcome> {
  return new Promise<DialogOutcome>((resolve) => {
    let settled = false;
    let dialog: QuestionDialog | undefined;
    const finish = (outcome: DialogOutcome): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      dialog?.cancel("aborted");
      if (!dialog) finish({ kind: "cancelled", reason: "aborted", answers: [] });
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    void ctx.ui
      .custom<DialogOutcome>(
        (tui, theme, keybindings, done) => {
          dialog = new QuestionDialog(tui, theme, keybindings, questions, (outcome) => {
            done(outcome);
            finish(outcome);
          });
          return dialog;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            minWidth: 36,
            maxHeight: "85%",
            margin: 1,
          },
        },
      )
      .then((outcome) => finish(outcome ?? { kind: "cancelled", reason: "disposed", answers: [] }))
      .catch((_error: unknown) => {
        finish({ kind: "cancelled", reason: "ui_error", answers: [] });
      });
  });
}

async function askWithRpcFallback(
  questions: Question[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<
  | { kind: "answered"; answers: QuestionAnswer[] }
  | { kind: "cancelled"; reason: CancellationReason; answers: QuestionAnswer[] }
> {
  const answers: (QuestionAnswer | undefined)[] = new Array<QuestionAnswer | undefined>(questions.length).fill(
    undefined,
  );
  let index = 0;
  while (index < questions.length) {
    const question = questions[index];
    if (!question) return { kind: "cancelled", reason: "ui_error", answers: complete(answers) };
    const choice = question.multiSelect
      ? await selectMulti(question, index, questions.length, ctx, signal)
      : await selectSingle(question, index, questions.length, index > 0, ctx, signal);
    if (choice.kind === "cancelled") return { ...choice, answers: complete(answers) };
    if (choice.kind === "back") {
      if (index > 0) {
        answers[index] = undefined;
        index -= 1;
        answers[index] = undefined;
      }
      continue;
    }
    if (choice.kind === "other") {
      const text = await withAbort(
        ctx.ui.editor(`${progress(index, questions.length)}${question.header}: ${question.question}`, ""),
        signal,
      );
      if (text === undefined)
        return { kind: "cancelled", reason: signal?.aborted ? "aborted" : "cancelled", answers: complete(answers) };
      const freeText = sanitizeDisplayText(text, 4_000);
      if (!freeText) continue;
      answers[index] = answerFor(question, choice.selections, freeText);
    } else {
      answers[index] = answerFor(question, choice.selections);
    }
    index += 1;
  }
  return { kind: "answered", answers: complete(answers) };
}

type FallbackChoice =
  | { kind: "selected"; selections: QuestionSelection[] }
  | { kind: "other"; selections: QuestionSelection[] }
  | { kind: "back" }
  | { kind: "cancelled"; reason: CancellationReason };

async function selectSingle(
  question: Question,
  index: number,
  total: number,
  canGoBack: boolean,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<FallbackChoice> {
  const values = question.options.map((option, optionIndex) => ({
    text: `${option.label}${option.description ? ` — ${option.description}` : ""}`,
    selection: { label: option.label, value: option.value, index: optionIndex },
  }));
  const other = "Other (free text)";
  const back = "Back (revise previous answer)";
  const options = [
    ...values.map((value) => value.text),
    ...(question.allowOther ? [other] : []),
    ...(canGoBack ? [back] : []),
  ];
  const selected = await withAbort(
    ctx.ui.select(`${progress(index, total)}${question.header}: ${question.question}`, options),
    signal,
  );
  if (selected === undefined) return { kind: "cancelled", reason: signal?.aborted ? "aborted" : "cancelled" };
  if (selected === other) return { kind: "other", selections: [] };
  if (selected === back) return { kind: "back" };
  const value = values.find((entry) => entry.text === selected);
  return value ? { kind: "selected", selections: [value.selection] } : { kind: "cancelled", reason: "ui_error" };
}

async function selectMulti(
  question: Question,
  index: number,
  total: number,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<FallbackChoice> {
  const selected = new Set<number>();
  let custom = false;
  while (true) {
    const values = question.options.map((option, optionIndex) => ({
      text: `${selected.has(optionIndex) ? "[x]" : "[ ]"} ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      selection: { label: option.label, value: option.value, index: optionIndex },
    }));
    const other = `${custom ? "[x]" : "[ ]"} Other (free text)`;
    const done = "Done";
    const back = "Back (revise previous answer)";
    const options = [
      ...values.map((value) => value.text),
      ...(question.allowOther ? [other] : []),
      done,
      ...(index > 0 ? [back] : []),
    ];
    const choice = await withAbort(
      ctx.ui.select(`${progress(index, total)}${question.header}: ${question.question}`, options),
      signal,
    );
    if (choice === undefined) return { kind: "cancelled", reason: signal?.aborted ? "aborted" : "cancelled" };
    if (choice === done) {
      return {
        kind: "selected",
        selections: [
          ...values.filter((_value, optionIndex) => selected.has(optionIndex)).map((value) => value.selection),
        ],
      };
    }
    if (choice === back) return { kind: "back" };
    const optionIndex = values.findIndex((value) => value.text === choice);
    if (optionIndex >= 0) {
      if (selected.has(optionIndex)) selected.delete(optionIndex);
      else selected.add(optionIndex);
      continue;
    }
    if (choice === other) {
      custom = true;
      return {
        kind: "other",
        selections: [
          ...values.filter((_value, optionIndex) => selected.has(optionIndex)).map((value) => value.selection),
        ],
      };
    }
    return { kind: "cancelled", reason: "ui_error" };
  }
}

function answerFor(question: Question, selections: QuestionSelection[], freeText?: string): QuestionAnswer {
  const answer: QuestionAnswer = {
    id: question.id,
    header: question.header,
    question: question.question,
    wasCustom: freeText !== undefined,
  };
  if (question.multiSelect) answer.selected = selections;
  else if (selections[0]) answer.selected = selections[0];
  if (freeText !== undefined) answer.freeText = freeText;
  return answer;
}

function complete(answers: (QuestionAnswer | undefined)[]): QuestionAnswer[] {
  return answers.filter((answer): answer is QuestionAnswer => answer !== undefined);
}

function progress(index: number, total: number): string {
  return total > 1 ? `[${index + 1}/${total}] ` : "";
}

function cancellation(
  questions: Question[],
  reason: CancellationReason,
  message: string,
  answers: QuestionAnswer[] = [],
): AskUserQuestionResult {
  return result({ version: 1, cancelled: true, questions, answers, reason, message });
}

function answered(questions: Question[], answers: QuestionAnswer[]): AskUserQuestionResult {
  return result({ version: 1, cancelled: false, questions, answers });
}

function result(details: AskUserQuestionDetails): AskUserQuestionResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function cancelMessage(reason: CancellationReason): string {
  switch (reason) {
    case "aborted":
      return "The question request was aborted.";
    case "disposed":
      return "The question dialog was disposed.";
    case "ui_unavailable":
      return "Interactive UI is not available in this context.";
    case "ui_error":
      return "The question UI could not collect a complete answer.";
    case "invalid_input":
      return "The supplied question payload was invalid.";
    case "cancelled":
      return "The user cancelled the question dialog.";
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  if (!signal) return promise;
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(finish, () => finish(undefined));
  });
}
