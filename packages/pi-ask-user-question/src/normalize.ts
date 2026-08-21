export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_ID_LENGTH = 80;
export const MAX_HEADER_LENGTH = 80;
export const MAX_QUESTION_LENGTH = 1_000;
export const MAX_LABEL_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;

import { stripVTControlCharacters } from "node:util";
export const MAX_VALUE_LENGTH = 200;
export const MAX_FREE_TEXT_LENGTH = 4_000;

export interface QuestionOption {
  label: string;
  description?: string;
  value: string;
}

export interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export interface QuestionSelection {
  label: string;
  value: string;
  index: number;
}

export interface QuestionAnswer {
  id: string;
  header: string;
  question: string;
  selected?: QuestionSelection | QuestionSelection[];
  freeText?: string;
  wasCustom: boolean;
}

export type NormalizationResult = { ok: true; questions: Question[] } | { ok: false; error: string };

/** Remove terminal controls and make model-provided labels safe single-line display text. */
export function sanitizeDisplayText(value: string, maxLength: number): string {
  const withoutTerminalSequences = stripVTControlCharacters(value);
  const withoutControls = Array.from(withoutTerminalSequences)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint > 0x1f &&
        codePoint !== 0x7f &&
        !(codePoint >= 0x80 && codePoint <= 0x9f) &&
        ![
          0x200b, 0x200c, 0x200d, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
        ].includes(codePoint)
      );
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return withoutControls.slice(0, maxLength).trim();
}

export function normalizeQuestions(input: unknown): NormalizationResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, error: "questions must be an array" };
  }
  if (input.questions.length < 1 || input.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: `questions must contain 1-${MAX_QUESTIONS} items` };
  }

  const ids = new Set<string>();
  const questions: Question[] = [];
  for (const [questionIndex, rawQuestion] of input.questions.entries()) {
    if (!isRecord(rawQuestion)) return { ok: false, error: `question ${questionIndex + 1} must be an object` };

    const question = requiredText(rawQuestion.question, MAX_QUESTION_LENGTH);
    if (!question) return { ok: false, error: `question ${questionIndex + 1} requires a non-empty question` };

    const rawOptions = rawQuestion.options;
    if (!Array.isArray(rawOptions))
      return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
    if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
      return {
        ok: false,
        error: `question ${questionIndex + 1} options must contain ${MIN_OPTIONS}-${MAX_OPTIONS} items`,
      };
    }

    const options: QuestionOption[] = [];
    for (const [optionIndex, rawOption] of rawOptions.entries()) {
      if (!isRecord(rawOption)) {
        return { ok: false, error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object` };
      }
      const label = requiredText(rawOption.label, MAX_LABEL_LENGTH);
      if (!label) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a non-empty label`,
        };
      }
      const description = optionalText(rawOption.description, MAX_DESCRIPTION_LENGTH);
      if (rawOption.description !== undefined && rawOption.description !== null && description === undefined) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} has an invalid description`,
        };
      }
      const rawValue = rawOption.value;
      const value = rawValue === undefined ? label : requiredText(rawValue, MAX_VALUE_LENGTH);
      if (!value) {
        return { ok: false, error: `question ${questionIndex + 1} option ${optionIndex + 1} has an invalid value` };
      }
      options.push(description ? { label, description, value } : { label, value });
    }

    const id =
      rawQuestion.id === undefined ? `question-${questionIndex + 1}` : requiredText(rawQuestion.id, MAX_ID_LENGTH);
    if (!id) return { ok: false, error: `question ${questionIndex + 1} has an invalid id` };
    if (ids.has(id)) return { ok: false, error: `duplicate question id: ${id}` };
    ids.add(id);

    const header =
      rawQuestion.header === undefined
        ? `Question ${questionIndex + 1}`
        : requiredText(rawQuestion.header, MAX_HEADER_LENGTH);
    if (!header) return { ok: false, error: `question ${questionIndex + 1} has an invalid header` };

    if (rawQuestion.multiSelect !== undefined && typeof rawQuestion.multiSelect !== "boolean") {
      return { ok: false, error: `question ${questionIndex + 1} multiSelect must be a boolean` };
    }
    if (rawQuestion.allowOther !== undefined && typeof rawQuestion.allowOther !== "boolean") {
      return { ok: false, error: `question ${questionIndex + 1} allowOther must be a boolean` };
    }

    questions.push({
      id,
      header,
      question,
      options,
      multiSelect: rawQuestion.multiSelect ?? false,
      allowOther: rawQuestion.allowOther ?? true,
    });
  }
  return { ok: true, questions };
}

function requiredText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = sanitizeDisplayText(value, maxLength);
  return result.length > 0 ? result : undefined;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
