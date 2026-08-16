import assert from "node:assert/strict";
import test from "node:test";
import { buildRecapContext } from "../index.ts";

const initialTask = `Build a session recap that preserves the user's task framing. ${"context ".repeat(100)}`.trim();
const summary =
  `The recap extension now works, but its output lacks the original task context. ${"detail ".repeat(120)}`.trim();
const toolResult = `The implementation still flattens and truncates the conversation. ${"output ".repeat(1000)}`;

const initialEntry = {
  type: "message",
  message: { role: "user", content: initialTask, timestamp: 1 },
};
const currentEntries = [
  {
    type: "compaction",
    summary,
  },
  {
    type: "message",
    message: { role: "user", content: "Make it match Claude Code more closely.", timestamp: 2 },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I am comparing the two implementations." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/services/awaySummary.ts" } },
      ],
      timestamp: 3,
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: toolResult }],
      isError: false,
      timestamp: 4,
    },
  },
];

test("recap context keeps broad task framing and recent native messages", () => {
  const context = buildRecapContext(currentEntries, [initialEntry, ...currentEntries]);

  assert.equal(context.broaderContext, `Initial user request:\n${initialTask}\n\nSession summary:\n${summary}`);
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(
    context.messages[2].content[0].text,
    `${toolResult.slice(0, 2000)}\n… [tool result truncated for recap] …\n${toolResult.slice(-2000)}`,
  );
});

test("recap context uses a 30-message recent window and bounds initial framing", () => {
  const initialRequest = `Start of request. ${"detail ".repeat(1500)}End of request.`;
  const branch = [];
  for (let i = 1; i <= 16; i++) {
    branch.push(
      { type: "message", message: { role: "user", content: i === 1 ? initialRequest : `User request ${i}` } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: `Response ${i}` }] } },
    );
  }

  const context = buildRecapContext(branch, branch);
  assert.equal(context.messages.length, 30);
  assert.equal(context.messages[0].content, "User request 2");
  assert.ok(context.broaderContext.startsWith("Initial user request:\nStart of request."));
  assert.match(context.broaderContext, /\[middle of initial request omitted for recap\]/);
  assert.ok(context.broaderContext.endsWith("End of request."));
});

test("recap context adds a user boundary before an assistant-led window", () => {
  const branch = [{ type: "message", message: { role: "user", content: "Investigate the failing build." } }];
  for (let i = 1; i <= 16; i++) {
    branch.push(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `file-${i}` } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `call-${i}`,
          toolName: "read",
          content: [{ type: "text", text: `file ${i} contents` }],
        },
      },
    );
  }

  const context = buildRecapContext(branch, branch);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, "(Earlier conversation omitted.)");
  assert.equal(context.messages[1].role, "assistant");
});

test("recap context does not repeat a recent initial request", () => {
  const context = buildRecapContext([initialEntry], [initialEntry]);
  assert.equal(context.broaderContext, undefined);
});
