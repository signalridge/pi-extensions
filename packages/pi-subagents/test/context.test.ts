/**
 * context.test.ts — Parent conversation context extraction for inherit_context spawns.
 *
 * buildParentContext shapes what a subagent sees from its parent; silent bugs
 * here would feed wrong context into spawns. Tests use realistic SessionEntry
 * shapes and a minimal ExtensionContext stub for older Pi versions, plus a real
 * SessionManager to check context edits against the model-visible projection.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildParentContext, extractText } from "../src/context.js";

function makeCtx(entries: { type: string; message?: unknown; summary?: string }[]): ExtensionContext {
  return {
    sessionManager: {
      buildSessionContext: () => ({
        messages: entries.flatMap((entry) => entry.type === "message" ? [entry.message]
          : entry.type === "compaction" ? [{ role: "compactionSummary", summary: entry.summary }] : []),
      }),
    },
  } as unknown as ExtensionContext;
}

function userMsg(content: string | unknown[]) {
  return { type: "message", message: { role: "user", content } };
}

function assistantMsg(blocks: unknown[]) {
  return { type: "message", message: { role: "assistant", content: blocks } };
}

describe("extractText", () => {
  it("joins multiple text blocks with newlines", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("filters out non-text blocks (tool_use, etc.)", () => {
    expect(
      extractText([
        { type: "text", text: "keep" },
        { type: "tool_use", name: "x", input: {} },
        { type: "text", text: "also keep" },
      ]),
    ).toBe("keep\nalso keep");
  });

  it("treats a text block with missing text field as empty", () => {
    expect(extractText([{ type: "text" }, { type: "text", text: "x" }])).toBe("\nx");
  });

  it("returns empty string for an empty content array", () => {
    expect(extractText([])).toBe("");
  });
});

describe("buildParentContext", () => {
  it("returns empty string for an empty branch", () => {
    expect(buildParentContext(makeCtx([]))).toBe("");
  });

  it("returns empty string when no entries produce extractable content", () => {
    // toolResult is skipped, empty-summary compaction is skipped
    const out = buildParentContext(
      makeCtx([
        { type: "message", message: { role: "tool_result", content: "..." } },
        { type: "compaction", summary: "" },
      ]),
    );
    expect(out).toBe("");
  });

  it("wraps a user+assistant exchange with the parent-context header and task footer", () => {
    const out = buildParentContext(
      makeCtx([userMsg("hello"), assistantMsg([{ type: "text", text: "hi back" }])]),
    );
    expect(out).toContain("# Parent Conversation Context");
    expect(out).toContain("[User]: hello");
    expect(out).toContain("[Assistant]: hi back");
    expect(out).toMatch(/# Your Task \(below\)\n$/);
    // Entries are joined with a blank line, preserving conversation order
    expect(out).toContain("[User]: hello\n\n[Assistant]: hi back");
  });

  it("accepts user messages whose content is content-blocks (not just a string)", () => {
    const out = buildParentContext(makeCtx([userMsg([{ type: "text", text: "from blocks" }])]));
    expect(out).toContain("[User]: from blocks");
  });

  it("uses the older host's resolved context after compaction", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "PRE_COMPACTION_TURN", timestamp: 1 });
    const keptId = session.appendMessage({ role: "user", content: "KEPT_TURN", timestamp: 2 });
    session.appendCompaction("COMPACTION_SUMMARY", keptId, 500);
    session.appendMessage(fauxAssistantMessage("AFTER_COMPACTION"));
    // Simulate a host without buildSessionProjection, while its real
    // SessionManager still resolves what the provider sees.
    const olderManager = {
      getBranch: () => session.getBranch(),
      buildSessionContext: () => session.buildSessionContext(),
    };
    const visible = olderManager.buildSessionContext().messages;
    expect(visible.map((message) => message.role)).toEqual([
      "compactionSummary", "user", "assistant",
    ]);
    const out = buildParentContext({ sessionManager: olderManager } as unknown as ExtensionContext);
    expect(out.match(/\[(?:Summary|User|Assistant)\]: [^\n]+/g)).toEqual([
      "[Summary]: COMPACTION_SUMMARY",
      "[User]: KEPT_TURN",
      "[Assistant]: AFTER_COMPACTION",
    ]);
  });

  it("skips tool_result messages — they're too verbose for inherited context", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("real user"),
        { type: "message", message: { role: "tool_result", content: "noisy tool output" } },
        assistantMsg([{ type: "text", text: "real assistant" }]),
      ]),
    );
    expect(out).not.toContain("noisy tool output");
    expect(out).toContain("[User]: real user");
    expect(out).toContain("[Assistant]: real assistant");
  });

  it("trims and skips whitespace-only messages", () => {
    const out = buildParentContext(
      makeCtx([userMsg("   \n  "), assistantMsg([{ type: "text", text: "non-empty" }])]),
    );
    expect(out).not.toMatch(/\[User\]:/);
    expect(out).toContain("[Assistant]: non-empty");
  });

  it("ignores assistant messages whose only content is non-text blocks", () => {
    // Assistant emitted only a tool_use — nothing extractable, so it shouldn't appear
    const out = buildParentContext(
      makeCtx([
        userMsg("question"),
        assistantMsg([{ type: "tool_use", name: "x", input: {} }]),
      ]),
    );
    expect(out).toContain("[User]: question");
    expect(out).not.toContain("[Assistant]:");
  });

  it("does not render aborted or provider-error assistant turns as model-visible context", () => {
    const out = buildParentContext(makeCtx([
      userMsg("task"),
      { type: "message", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "FAILED_PARTIAL" }] } },
      { type: "message", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "ABORTED_PARTIAL" }] } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "COMPLETED" }] } },
    ]));
    expect(out).toContain("[User]: task");
    expect(out).toContain("[Assistant]: COMPLETED");
    expect(out).not.toContain("FAILED_PARTIAL");
    expect(out).not.toContain("ABORTED_PARTIAL");
  });

  it("uses the real session projection to omit and replace edited parent content", () => {
    const session = SessionManager.inMemory();
    const omittedId = session.appendMessage({ role: "user", content: "PRIVATE_OMITTED", timestamp: 1 });
    const replacedId = session.appendMessage({ role: "user", content: "PRIVATE_ORIGINAL", timestamp: 2 });
    const assistantId = session.appendMessage(fauxAssistantMessage("PRIVATE_ASSISTANT"));
    const toolId = session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }],
      isError: false,
      timestamp: 3,
    });
    session.appendContextEdit(omittedId, null);
    session.appendContextEdit(replacedId, { content: "REPLACEMENT_VISIBLE" });
    session.appendContextEdit(assistantId, { content: [{ type: "text", text: "SAFE_ASSISTANT" }] });
    session.appendContextEdit(toolId, { content: [{ type: "text", text: "SAFE_TOOL_RESULT" }] });

    expect(JSON.stringify(session.getBranch())).toContain("PRIVATE_OMITTED");
    expect(JSON.stringify(session.getBranch())).toContain("PRIVATE_ORIGINAL");
    const childPrompt = buildParentContext({ sessionManager: session } as ExtensionContext) + "CHILD_TASK";
    expect(childPrompt).not.toContain("PRIVATE_OMITTED");
    expect(childPrompt).not.toContain("PRIVATE_ORIGINAL");
    expect(childPrompt).not.toContain("PRIVATE_ASSISTANT");
    expect(childPrompt).not.toContain("PRIVATE_TOOL_OUTPUT");
    expect(childPrompt).toContain("[User]: REPLACEMENT_VISIBLE");
    expect(childPrompt).toContain("[Assistant]: SAFE_ASSISTANT");
    expect(childPrompt).toContain("[Tool Result (read)]: SAFE_TOOL_RESULT");
    expect(childPrompt).toMatch(/# Your Task \(below\)\nCHILD_TASK$/);
  });

  it("bounds inherited tool output while retaining the failure tail", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "bash",
      content: [{ type: "text", text: `${"x".repeat(3_000)}\nIMPORTANT FAILURE` }],
      isError: true,
      timestamp: 1,
    });
    const out = buildParentContext({ sessionManager: session } as ExtensionContext);
    expect(out).toContain("[Tool Result (bash)]: x");
    expect(out).toContain("IMPORTANT FAILURE");
    expect(out).toContain("...[truncated]...");
    expect(out).not.toContain("x".repeat(2_001));
  });

  it("includes model-visible shell executions but excludes !! commands", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({
      role: "bashExecution", command: "npm test", output: "tests passed",
      exitCode: 0, cancelled: false, truncated: false, timestamp: 1,
    });
    session.appendMessage({
      role: "bashExecution", command: "private command", output: "PRIVATE_OUTPUT",
      exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 2,
    });
    const out = buildParentContext({ sessionManager: session } as ExtensionContext);
    expect(out).toContain("Ran `npm test`");
    expect(out).toContain("tests passed");
    expect(out).not.toContain("private command");
    expect(out).not.toContain("PRIVATE_OUTPUT");
  });

  it("retains the tail and outcome of a truncated shell execution", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({
      role: "bashExecution", command: "run check", output: `${"x".repeat(5_000)}\nLAST ERROR`,
      exitCode: 2, cancelled: false, truncated: true, fullOutputPath: "/tmp/full-output",
      timestamp: 1,
    });
    const out = buildParentContext({ sessionManager: session } as ExtensionContext);
    expect(out).toContain("LAST ERROR");
    expect(out).toContain("Command exited with code 2");
    expect(out).toContain("Output truncated. Full output: /tmp/full-output");
    expect(out).not.toContain("x".repeat(2_001));
  });

  it("caps the total inherited text for a 65k child and keeps recent work plus summary", () => {
    const session = SessionManager.inMemory();
    const first = session.appendMessage({ role: "user", content: "FIRST_OLD_TURN", timestamp: 1 });
    session.appendCompaction("PROJECT_SUMMARY", first, 100);
    for (let i = 0; i < 100; i++) {
      session.appendMessage({ role: "user", content: `turn-${i}: ${"x".repeat(1_000)}`, timestamp: i + 2 });
    }
    const out = buildParentContext({ sessionManager: session } as ExtensionContext, 65_000);
    expect(out.length).toBeLessThanOrEqual(Math.floor(65_000 / 4));
    expect(out).toContain("[Summary]: PROJECT_SUMMARY");
    expect(out).toContain("turn-99:");
    expect(out).not.toContain("turn-1:");
    expect(out).toMatch(/# Your Task \(below\)\n$/);
  });

  it("never consults raw history when a projection is available, even when empty", () => {
    const ctx = {
      sessionManager: {
        getBranch: () => { throw new Error("raw history is unavailable"); },
        buildSessionProjection: () => ({ entries: [] }),
      },
    } as unknown as ExtensionContext;
    expect(buildParentContext(ctx)).toBe("");
  });

  it("inherits only the active compacted context instead of the entire raw branch", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "PRE_COMPACTION_SECRET", timestamp: 1 });
    const keptId = session.appendMessage({ role: "user", content: "KEPT_TURN", timestamp: 2 });
    session.appendCompaction("SAFE_SUMMARY", keptId, 500);
    const out = buildParentContext({ sessionManager: session } as ExtensionContext);
    expect(out).not.toContain("PRE_COMPACTION_SECRET");
    expect(out).toContain("[Summary]: SAFE_SUMMARY");
    expect(out).toContain("[User]: KEPT_TURN");
  });
});
