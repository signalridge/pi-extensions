import assert from "node:assert/strict";
import { test } from "vitest";
import { buildConversationContext } from "../src/btw.js";

const notice = "[Earlier context omitted; showing the last 40000 characters.]\n";
const truncated = (text: string) => (text.length > 40_000 ? notice + text.slice(-40_000) : text);
const result = (content: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "read", content } });

test("12000 real-shaped tool results retain the newest suffix without joining 600MB", () => {
  const shared = "x".repeat(50_000);
  const entries = Array.from({ length: 12_000 }, (_, index) => ({
    ...result([{ type: "text", text: shared }]),
    id: String(index),
    parentId: String(index - 1),
  }));
  entries.push({ ...result([{ type: "text", text: "newest diagnostic" }]), id: "latest", parentId: "11999" });
  const first = entries[0];
  assert.equal(
    buildConversationContext(entries),
    notice + `${shared}\n\nTool result from read: newest diagnostic`.slice(-40_000),
  );
  assert.equal(entries[0], first, "input order is unchanged");
});

test("stops before accessing older content or arguments once the suffix budget is exhausted", () => {
  const older = {
    type: "message",
    message: {
      role: "assistant",
      get content(): unknown {
        throw new Error("old content accessed");
      },
    },
  };
  const oversized = "a".repeat(50_000);
  const oldBlock = {
    type: "toolCall",
    name: "old",
    get arguments(): unknown {
      throw new Error("old arguments accessed");
    },
  };
  assert.equal(
    buildConversationContext([older, result([oldBlock, { type: "text", text: oversized }])]),
    notice + oversized.slice(-40_000),
  );
});

test("oversized single strings and multiple blocks preserve exact suffix semantics", () => {
  for (const blocks of [
    [" x ", "y".repeat(50_000)],
    ["a".repeat(30_000), " ", "b".repeat(30_000), " newest "],
    ["a".repeat(39_976)],
    ["a".repeat(39_977)],
    ["a".repeat(39_978)],
  ]) {
    const expected = truncated(
      `Tool result from read: ${blocks
        .map((text) => text.trim())
        .filter(Boolean)
        .join("\n")}`,
    );
    assert.equal(buildConversationContext([result(blocks.map((text) => ({ type: "text", text })))]), expected);
  }
  const text = " x".repeat(30_000);
  assert.equal(buildConversationContext([result(text)]), truncated(`Tool result from read: ${text.trim()}`));
});

test("tool arguments are suffix-serialized within budget, including escaped strings and collections", () => {
  for (const args of [
    { a: 1, b: [true, null, "value"] },
    Object.assign(Object.create({ inherited: "excluded" }), { 2: "two", 1: "one", z: "last" }),
    { text: '"\\\n'.repeat(30_000) },
    Array.from({ length: 12_000 }, () => "x".repeat(5)),
  ]) {
    const text = `Assistant: Tool call: execute(${JSON.stringify(args)})`;
    assert.equal(
      buildConversationContext([
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", name: "execute", arguments: args }] },
        },
      ]),
      truncated(text),
    );
  }
  const shared = "x".repeat(50_000);
  const wide: Record<string, string> = {};
  for (let index = 0; index < 120_000; index++) wide[`key-${index}`] = shared;
  assert.equal(
    buildConversationContext([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name: "execute", arguments: wide }] },
      },
    ]),
    notice + `${JSON.stringify(shared)}})`.slice(-40_000),
  );
  const args = Array.from({ length: 12_000 }, () => shared);
  const suffix = `${JSON.stringify(shared)}])`.slice(-40_000);
  assert.equal(
    buildConversationContext([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name: "execute", arguments: args }] },
      },
    ]),
    notice + suffix,
  );
});
