import assert from "node:assert/strict";
import { test } from "vitest";
import { ASK_USER_QUESTION_TOOL_NAME, askUserQuestionTool } from "../src/ask-user-question.js";

test("implementation exports the canonical tool name and metadata", () => {
  assert.equal(askUserQuestionTool.name, ASK_USER_QUESTION_TOOL_NAME);
  assert.equal(askUserQuestionTool.executionMode, "sequential");
  assert.match(askUserQuestionTool.description, /user/i);
  assert.equal(typeof askUserQuestionTool.execute, "function");
});
