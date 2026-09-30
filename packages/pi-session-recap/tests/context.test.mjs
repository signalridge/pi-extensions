import assert from "node:assert/strict";
import test from "node:test";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
  buildContextEntries,
  buildSessionProjection,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { buildRecapContext, hasMeaningfulActivity } from "../index.ts";

const initialTask = `Build a session recap that preserves the user's task framing. ${"context ".repeat(100)}`.trim();
const summary =
  `The recap extension now works, but its output lacks the original task context. ${"detail ".repeat(120)}`.trim();
const toolResult = `The implementation still flattens and truncates the conversation. ${"output ".repeat(1000)}`;

function completeBranch(entries) {
  let parentId = null;
  return entries.map((entry, index) => {
    const id = entry.id ?? `entry-${index}`;
    const result = { ...entry, id, parentId, timestamp: entry.timestamp ?? new Date(index * 1000).toISOString() };
    parentId = id;
    return result;
  });
}

function recap(entries) {
  const branch = completeBranch(entries);
  return buildRecapContext(buildSessionProjection(branch).entries, branch);
}

const initialEntry = {
  type: "message",
  message: { role: "user", content: initialTask, timestamp: 1 },
};
const currentEntries = [
  { type: "branch_summary", fromId: "old-leaf", summary },
  { type: "message", message: { role: "user", content: "Make it match Claude Code more closely.", timestamp: 2 } },
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

test("recap context keeps broad task framing and recent projected messages", () => {
  const context = recap([initialEntry, ...currentEntries]);

  assert.equal(context.broaderContext, `Session summary:\n${summary}`);
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "user", "assistant", "toolResult"],
  );
  assert.equal(context.messages[0].content, initialTask);
  assert.equal(
    context.messages[3].content[0].text,
    `${toolResult.slice(0, 2000)}\n… [tool result truncated for recap] …\n${toolResult.slice(-2000)}`,
  );
});

test("legacy projection keeps the active compaction summary when an older checkpoint is retained", () => {
  const entries = [
    { sourceEntry: { type: "compaction", id: "active", summary: "Current summary" }, messages: [{}] },
    { sourceEntry: { type: "compaction", id: "retained", summary: "Obsolete summary" }, messages: [{}] },
  ];
  assert.equal(buildRecapContext(entries, []).broaderContext, "Session summary:\nCurrent summary");
});

test("a retained older branch summary cannot supersede the active compaction", () => {
  const branch = completeBranch([
    { type: "message", id: "user", message: { role: "user", content: "Current task" } },
    { type: "branch_summary", id: "older", fromId: "user", summary: "Obsolete branch summary" },
    { type: "message", id: "later", message: { role: "user", content: "Continue" } },
    {
      type: "compaction",
      id: "current",
      summary: "Current compaction summary",
      firstKeptEntryId: "older",
      tokensBefore: 1000,
    },
    { type: "message", id: "answer", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
  ]);
  const context = buildRecapContext(buildSessionProjection(branch).entries, branch);
  assert.match(context.broaderContext, /Session summary:\nCurrent compaction summary$/);
  assert.doesNotMatch(context.broaderContext, /Obsolete branch summary/);
});

test("legacy null user content does not prevent a later usable request", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: null, timestamp: 1 } },
    { type: "message", message: { role: "user", content: "Current request", timestamp: 2 } },
  ]);
  const context = buildRecapContext(buildSessionProjection(branch).entries, branch);
  assert.deepEqual(
    context.messages.map((message) => message.content),
    [[], "Current request"],
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

  const context = recap(branch);
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

  const context = recap(branch);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, "(Earlier conversation omitted.)");
  assert.equal(context.messages[1].role, "assistant");
});

test("recap context does not repeat a recent initial request", () => {
  assert.equal(recap([initialEntry]).broaderContext, undefined);
});

test("context edits replace recent messages and original task framing", () => {
  const context = recap([
    { ...initialEntry, id: "initial" },
    { type: "context_edit", targetId: "initial", replacement: { content: "Build the corrected projected task." } },
  ]);

  assert.deepEqual(
    context.messages.map((message) => message.content),
    ["Build the corrected projected task."],
  );
  assert.doesNotMatch(JSON.stringify(context), /preserves the user's task framing/);
});

test("the latest context edit wins for an initial user request", () => {
  const context = recap([
    { ...initialEntry, id: "initial" },
    { type: "context_edit", targetId: "initial", replacement: null },
    { type: "context_edit", targetId: "initial", replacement: { content: "Only the final request survives." } },
    { type: "message", message: { role: "user", content: "Continue." } },
  ]);
  assert.deepEqual(
    context.messages.map((message) => message.content),
    ["Only the final request survives.", "Continue."],
  );
  assert.doesNotMatch(JSON.stringify(context), /preserves the user's task framing/);
});

test("omitted assistant and user messages do not supply activity or task framing", () => {
  const entries = [
    { type: "message", id: "old-user", message: { role: "user", content: "Discarded task" } },
    {
      type: "message",
      id: "old-assistant",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-old", name: "read", arguments: { path: "old.ts" } }],
      },
    },
    { type: "context_edit", targetId: "old-user", replacement: null },
    { type: "context_edit", targetId: "old-assistant", replacement: null },
    { type: "message", message: { role: "user", content: "Current task" } },
  ];
  const projection = buildSessionProjection(completeBranch(entries)).entries;
  const context = recap(entries);

  assert.deepEqual(
    context.messages.map((message) => message.content),
    ["Current task"],
  );
  assert.equal(context.broaderContext, undefined);
  assert.equal(hasMeaningfulActivity(projection), false);
});

test("activity threshold uses replacement assistant content rather than raw tool calls", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: "Fix the bug." } },
    {
      type: "message",
      id: "assistant",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    },
    { type: "context_edit", targetId: "assistant", replacement: { content: [{ type: "text", text: "No." }] } },
  ]);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(branch).entries), false);
});

test("projected custom messages do not hide completed assistant tool work", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: "Fix the bug." } },
    {
      type: "message",
      id: "assistant",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    },
    { type: "custom_message", customType: "status", content: "Progress saved", display: false },
  ]);
  const projection = buildSessionProjection(branch);

  assert.deepEqual(
    projection.messages.map((message) => message.role),
    ["user", "assistant", "custom"],
  );
  assert.equal(hasMeaningfulActivity(projection.entries), true);

  // A real next user request, unlike the custom message, starts a fresh window.
  const nextRequest = completeBranch([
    ...branch,
    { type: "message", message: { role: "user", content: "Start a different task." } },
  ]);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(nextRequest).entries), false);

  const edited = completeBranch([...branch, { type: "context_edit", targetId: "assistant", replacement: null }]);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(edited).entries), false);
});

test("a projected compaction summary alone retains meaningful activity on resume", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "Investigate the failure." } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    },
    {
      type: "compaction",
      id: "checkpoint",
      summary: "Investigated the failure and identified the next fix.",
      firstKeptEntryId: "checkpoint",
      tokensBefore: 100,
    },
  ];
  const branch = completeBranch(entries);
  const projection = buildSessionProjection(branch);

  assert.deepEqual(
    projection.entries.map(({ sourceEntry }) => sourceEntry.type),
    ["compaction"],
  );
  assert.deepEqual(
    projection.messages.map((message) => message.role),
    ["compactionSummary"],
  );
  assert.equal(hasMeaningfulActivity(projection.entries), true);
  assert.match(buildRecapContext(projection.entries, branch).broaderContext, /Investigated the failure/);

  const omitted = completeBranch([...entries, { type: "context_edit", targetId: "checkpoint", replacement: null }]);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(omitted).entries), false);

  const newRequest = completeBranch([
    ...entries,
    { type: "message", message: { role: "user", content: "Start a different task." } },
  ]);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(newRequest).entries), false);
});

test("activity follows the SDK's selected branch rather than a sibling's work", () => {
  const root = {
    type: "message",
    id: "root",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: "Fix the bug." },
  };
  const active = {
    type: "message",
    id: "active",
    parentId: "root",
    timestamp: new Date(1000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "Not yet." }] },
  };
  const sibling = {
    type: "message",
    id: "sibling",
    parentId: "root",
    timestamp: new Date(2000).toISOString(),
    message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
  };
  const projection = buildSessionProjection([root, active, sibling], "active");

  assert.deepEqual(
    projection.entries.map(({ sourceEntry }) => sourceEntry.id),
    ["root", "active"],
  );
  assert.equal(hasMeaningfulActivity(projection.entries), false);
});

test("recap context selects active compaction when older summaries are retained", () => {
  const branch = [
    { ...initialEntry, id: "initial" },
    {
      type: "compaction",
      id: "old-compaction",
      summary: "Stale compaction summary",
      firstKeptEntryId: "initial",
      tokensBefore: 100,
    },
    { type: "message", message: { role: "user", content: "Retained request" } },
    {
      type: "compaction",
      id: "active-compaction",
      summary: "Active compaction summary",
      firstKeptEntryId: "old-compaction",
      tokensBefore: 200,
    },
    { type: "message", message: { role: "user", content: "Current request" } },
  ];
  const context = recap(branch);
  assert.match(context.broaderContext, /Session summary:\nActive compaction summary/);
  assert.doesNotMatch(context.broaderContext, /Stale compaction summary/);
});

test("compacted recap context retains the edited original request", () => {
  const context = recap([
    { ...initialEntry, id: "initial" },
    {
      type: "compaction",
      id: "compaction",
      summary: "Work continues after compaction.",
      firstKeptEntryId: "compaction",
      tokensBefore: 100,
    },
    { type: "context_edit", targetId: "initial", replacement: { content: "Build the corrected original request." } },
    { type: "message", message: { role: "user", content: "Continue from the summary." } },
  ]);

  assert.match(context.broaderContext, /Initial user request:\nBuild the corrected original request\./);
  assert.doesNotMatch(context.broaderContext, /preserves the user's task framing/);
});

test("compacted recap context does not restore an omitted original request", () => {
  const context = recap([
    { ...initialEntry, id: "initial" },
    { type: "message", message: { role: "user", content: "Use this surviving task instead." } },
    {
      type: "compaction",
      id: "compaction",
      summary: "Work continues after compaction.",
      firstKeptEntryId: "compaction",
      tokensBefore: 100,
    },
    { type: "context_edit", targetId: "initial", replacement: null },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Continuing." }] } },
  ]);

  assert.match(context.broaderContext, /Initial user request:\nUse this surviving task instead\./);
  assert.doesNotMatch(context.broaderContext, /preserves the user's task framing/);
});

const chatModel = {
  id: "recap-chat-test",
  provider: "openai",
  api: "openai-completions",
  input: ["text"],
  reasoning: false,
};

function chatMessages(context) {
  return convertMessages(chatModel, { systemPrompt: "", messages: context.messages }, {});
}

test("a projected orphan result is removed without losing a valid tool pair in Chat Completions", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: "Check both files." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "valid-call", name: "read", arguments: { path: "valid" } }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "valid-call",
        toolName: "read",
        content: [{ type: "text", text: "Valid file contents" }],
      },
    },
    {
      type: "message",
      id: "omitted-call",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "orphan-call", name: "read", arguments: { path: "private" } }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "orphan-call",
        toolName: "read",
        content: [{ type: "text", text: "Orphaned payload" }],
      },
    },
    { type: "context_edit", targetId: "omitted-call", replacement: null },
  ]);
  const projected = buildSessionProjection(branch).entries;
  assert.deepEqual(
    projected
      .flatMap(({ messages }) => messages)
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
    ["valid-call", "orphan-call"],
  );

  const context = buildRecapContext(projected, branch);
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  const converted = chatMessages(context);
  assert.deepEqual(
    converted.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["valid-call"],
  );
  assert.deepEqual(
    converted.find((message) => message.role === "assistant").tool_calls.map((call) => call.id),
    ["valid-call"],
  );
  assert.doesNotMatch(JSON.stringify(converted), /Orphaned payload|orphan-call/);
});

test("results of an aborted assistant and duplicates cannot become orphan tool messages", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: "Read the file." } },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "toolCall", id: "failed-call", name: "read", arguments: {} }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "failed-call",
        toolName: "read",
        content: [{ type: "text", text: "Failed result" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "toolCall", id: "good-call", name: "read", arguments: {} }],
      },
    },
    ...["First result", "Duplicate result"].map((text) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "good-call",
        toolName: "read",
        content: [{ type: "text", text }],
      },
    })),
  ]);
  const projected = buildSessionProjection(branch).entries;
  assert.deepEqual(
    transformMessages(
      projected.flatMap(({ messages }) => messages),
      chatModel,
    )
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.filter((block) => block.type === "toolCall").map((block) => block.id)),
    ["good-call"],
  );
  const converted = chatMessages(buildRecapContext(projected, branch));
  assert.deepEqual(
    converted.filter((message) => message.role === "tool").map((message) => message.content),
    ["First result"],
  );
});

test("image-only request and >60 results for one call retain completed work on the wire", () => {
  const branch = completeBranch([
    {
      type: "message",
      message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "completed-read", name: "read", arguments: {} }],
      },
    },
    ...Array.from({ length: 75 }, (_, index) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "completed-read",
        toolName: "read",
        content: [{ type: "text", text: `result ${index}` }],
      },
    })),
  ]);
  const projection = buildSessionProjection(branch).entries;
  const context = buildRecapContext(projection, branch);
  const wire = chatMessages(context);
  assert.equal(context.broaderContext, undefined);
  assert.deepEqual(
    wire.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.deepEqual(wire[0].content, [{ type: "text", text: "(image omitted: model does not support images)" }]);
  assert.deepEqual(
    wire[1].tool_calls.map((call) => call.id),
    ["completed-read"],
  );
  assert.deepEqual([wire[2].tool_call_id, wire[2].content], ["completed-read", "result 0"]);
  assert.equal(context.messages.length, 3);
});

test("a long run of distinct results carries its call but stays bounded on the wire", () => {
  const branch = completeBranch([
    {
      type: "message",
      message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: Array.from({ length: 75 }, (_, index) => ({
          type: "toolCall",
          id: `read-${index}`,
          name: "read",
          arguments: { path: `file-${index}` },
        })),
      },
    },
    ...Array.from({ length: 75 }, (_, index) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `read-${index}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${index}` }],
      },
    })),
  ]);
  const projection = buildSessionProjection(branch).entries;
  const context = buildRecapContext(projection, branch);
  const wire = chatMessages(context);
  const expectedIds = Array.from({ length: 29 }, (_, index) => `read-${index + 46}`);
  assert.equal(context.broaderContext, undefined);
  assert.equal(context.messages.length, 31); // 30 recent messages plus an assistant-led user boundary
  assert.deepEqual(
    wire.map((message) => message.role),
    ["user", "assistant", ...expectedIds.map(() => "tool")],
  );
  assert.equal(wire[0].content, "(Earlier conversation omitted.)");
  assert.deepEqual(
    wire[1].tool_calls.map((call) => call.id),
    expectedIds,
  );
  assert.deepEqual(
    wire.slice(2).map(({ tool_call_id, content }) => [tool_call_id, content]),
    expectedIds.map((id, index) => [id, `result ${index + 46}`]),
  );
});

test("one completed call with many duplicate results remains paired and bounded on old Pi fallback", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: "Analyze the output." } },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "many-results", name: "read", arguments: {} }],
      },
    },
    ...Array.from({ length: 90 }, (_, index) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "many-results",
        toolName: "read",
        content: [{ type: "text", text: `result ${index}` }],
      },
    })),
  ]);
  // Older supported hosts lack buildSessionProjection; exercise the same
  // buildContextEntries + sessionEntryToContextMessages fallback as the extension.
  const fallback = buildContextEntries(branch).map((sourceEntry) => ({
    sourceEntry,
    messages: sessionEntryToContextMessages(sourceEntry),
  }));
  const context = buildRecapContext(fallback, branch);
  const wire = chatMessages(context);
  assert.deepEqual(
    wire.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(wire[0].content, "Analyze the output.");
  assert.deepEqual(
    wire[1].tool_calls.map((call) => call.id),
    ["many-results"],
  );
  assert.deepEqual([wire[2].tool_call_id, wire[2].content], ["many-results", "result 0"]);
  assert.equal(context.messages.length, 3);
});

test("incomplete turns do not displace completed work from the recent provider window", () => {
  const branch = completeBranch([
    { type: "message", message: { role: "user", content: "Review the output." } },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "The completed investigation found a missing result." },
          { type: "toolCall", id: "completed-read", name: "read", arguments: { path: "report" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "completed-read",
        toolName: "read",
        content: [{ type: "text", text: "report: ready" }],
      },
    },
    ...Array.from({ length: 31 }, (_, index) => ({
      type: "message",
      message: {
        role: "assistant",
        stopReason: index % 2 === 0 ? "aborted" : "error",
        content: [{ type: "text", text: `Unfinished attempt ${index}` }],
      },
    })),
  ]);
  const projection = buildSessionProjection(branch).entries;
  assert.equal(hasMeaningfulActivity(projection), true);
  const context = buildRecapContext(projection, branch);
  const wire = chatMessages(context);
  assert.deepEqual(
    wire.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(wire[0].content, "Review the output.");
  assert.equal(wire[1].content, "The completed investigation found a missing result.");
  assert.deepEqual(
    wire[1].tool_calls.map((call) => call.id),
    ["completed-read"],
  );
  assert.deepEqual([wire[2].tool_call_id, wire[2].content], ["completed-read", "report: ready"]);
});

test("aborted and errored assistant work is not meaningful, unlike earlier completed work", () => {
  const incomplete = ["aborted", "error"].map((stopReason) => ({
    type: "message",
    message: {
      role: "assistant",
      stopReason,
      content: [
        { type: "text", text: "partial ".repeat(35) },
        { type: "toolCall", id: `call-${stopReason}`, name: "read", arguments: {} },
      ],
    },
  }));
  for (const last of incomplete) {
    const branch = completeBranch([{ type: "message", message: { role: "user", content: "Fix it." } }, last]);
    const projection = buildSessionProjection(branch).entries;
    assert.equal(hasMeaningfulActivity(projection), false);
    assert.deepEqual(
      transformMessages(
        projection.flatMap(({ messages }) => messages),
        chatModel,
      ).map((message) => message.role),
      ["user"],
    );
    assert.deepEqual(
      chatMessages(buildRecapContext(projection, branch)).map((message) => message.role),
      ["user"],
    );
  }

  const completed = completeBranch([
    { type: "message", message: { role: "user", content: "Fix it." } },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "toolCall", id: "completed", name: "read", arguments: {} }],
      },
    },
    incomplete[0],
  ]);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(completed).entries), true);
});

test("many retained branch summaries select only the newest summary following compaction", () => {
  const old = Array.from({ length: 1200 }, (_, index) => ({
    type: "branch_summary",
    id: `old-${index}`,
    fromId: "initial",
    summary: `Old summary ${index}`,
  }));
  const newer = Array.from({ length: 1200 }, (_, index) => ({
    type: "branch_summary",
    id: `new-${index}`,
    fromId: "initial",
    summary: `New summary ${index}`,
  }));
  const branch = completeBranch([
    { type: "message", id: "initial", message: { role: "user", content: "Continue." } },
    ...old,
    { type: "compaction", id: "current", summary: "Current checkpoint", firstKeptEntryId: "old-0", tokensBefore: 100 },
    ...newer,
  ]);
  const projection = buildSessionProjection(branch).entries;
  const context = buildRecapContext(projection, branch);
  assert.equal(context.broaderContext, "Initial user request:\nContinue.\n\nSession summary:\nNew summary 1199");
  const withMissing = [
    ...projection,
    { sourceEntry: { type: "branch_summary", id: "not-in-branch", summary: "Missing" }, messages: [{}] },
  ];
  assert.equal(buildRecapContext(withMissing, branch).broaderContext, context.broaderContext);
});
