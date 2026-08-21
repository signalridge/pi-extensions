import assert from "node:assert/strict";
import { test } from "vitest";
import askUserQuestion, {
  ASK_USER_QUESTION_PARAMETERS,
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionResult,
  askUserQuestionTool,
} from "../src/ask-user-question.js";
import { normalizeQuestions } from "../src/normalize.js";
import { makeQuestions } from "./support.js";

test("registers one sequential tool with model guidance and bounded schema", () => {
  const registered: unknown[] = [];
  askUserQuestion({ registerTool: (tool: unknown) => registered.push(tool) } as never);
  assert.equal(registered.length, 1);
  const tool = registered[0] as typeof askUserQuestionTool;
  assert.equal(tool.name, ASK_USER_QUESTION_TOOL_NAME);
  assert.equal(tool.executionMode, "sequential");
  assert.ok(tool.promptSnippet);
  assert.ok(tool.promptGuidelines?.length);
  assert.equal(ASK_USER_QUESTION_PARAMETERS.properties.questions.minItems, 1);
  assert.equal(ASK_USER_QUESTION_PARAMETERS.properties.questions.maxItems, 4);
});

test("normalizes defaults, trims display text, and rejects malformed batches", () => {
  const normalized = normalizeQuestions({
    questions: [
      {
        question: "  Choose  \u001b[31mnow\u001b[0m  ",
        options: [{ label: " A " }, { label: " B ", value: " b " }],
      },
    ],
  });
  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.deepEqual(normalized.questions[0], {
      id: "question-1",
      header: "Question 1",
      question: "Choose now",
      options: [
        { label: "A", value: "A" },
        { label: "B", value: "b" },
      ],
      multiSelect: false,
      allowOther: true,
    });
  }
  assert.match(normalizeQuestions({ questions: [] }).error ?? "", /1-4/);
  assert.match(
    normalizeQuestions({
      questions: [
        { id: "same", question: "x", options: [{ label: "a" }, { label: "b" }] },
        { id: "same", question: "y", options: [{ label: "a" }, { label: "b" }] },
      ],
    }).error ?? "",
    /duplicate/i,
  );
  assert.match(normalizeQuestions({ questions: [{ question: "x", options: [{ label: "a" }] }] }).error ?? "", /2-4/);
});

test("non-TUI and no-UI execution returns structured cancellation without custom", async () => {
  let customCalls = 0;
  const execute = askUserQuestionTool.execute;
  const params = {
    questions: makeQuestions().map(({ id, header, question, options }) => ({ id, header, question, options })),
  };
  const result = await execute("print", params as never, undefined, undefined, {
    mode: "print",
    hasUI: false,
    ui: {
      custom: async () => {
        customCalls += 1;
        return undefined;
      },
      select: async () => undefined,
      editor: async () => undefined,
    },
  } as never);
  const typed = result as AskUserQuestionResult;
  assert.equal(typed.details.cancelled, true);
  assert.equal(typed.details.reason, "ui_unavailable");
  assert.equal(customCalls, 0);
  assert.deepEqual(JSON.parse(typed.content[0].text), typed.details);
});

test("RPC fallback answers single and batch questions, including Other and Back", async () => {
  const choices = ["Other (free text)", "Back (revise previous answer)", "Fast", "Safe"];
  const titles: string[] = [];
  const select = async (title: string): Promise<string | undefined> => {
    titles.push(title);
    return choices.shift();
  };
  const result = await askUserQuestionTool.execute(
    "rpc",
    {
      questions: [
        { id: "first", question: "First?", options: [{ label: "Fast" }, { label: "Slow" }] },
        { id: "second", question: "Second?", options: [{ label: "Safe" }, { label: "Risky" }] },
      ],
    } as never,
    undefined,
    undefined,
    { mode: "rpc", hasUI: true, ui: { custom: async () => undefined, select, editor: async () => "Changed" } } as never,
  );
  assert.equal(result.details.cancelled, false);
  assert.equal(
    result.details.answers[0]?.selected && !Array.isArray(result.details.answers[0].selected)
      ? result.details.answers[0].selected.label
      : "",
    "Fast",
  );
  assert.equal(
    result.details.answers[1]?.selected && !Array.isArray(result.details.answers[1].selected)
      ? result.details.answers[1].selected.label
      : "",
    "Safe",
  );
  assert.equal(titles.length, 4);
  assert.match(titles.at(-1) ?? "", /\[2\/2\]/);
});

test("RPC cancellation keeps ordered partial answers", async () => {
  let calls = 0;
  const result = await askUserQuestionTool.execute(
    "cancel",
    {
      questions: [
        { question: "One?", options: [{ label: "A" }, { label: "B" }] },
        { question: "Two?", options: [{ label: "C" }, { label: "D" }] },
      ],
    } as never,
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async () => (calls++ === 0 ? "A" : undefined),
        editor: async () => undefined,
      },
    } as never,
  );
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.reason, "cancelled");
  assert.equal(result.details.answers.length, 1);
  assert.equal(result.details.answers[0]?.id, "question-1");
});
