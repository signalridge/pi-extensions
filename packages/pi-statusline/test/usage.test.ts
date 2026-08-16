import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { FooterUsageAccumulator, summarizeFooterUsage } from "../src/usage.js";

function entry(value: unknown): SessionEntry {
  return value as SessionEntry;
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

test("footer usage includes every usage-bearing session entry and uses the latest assistant rate", () => {
  const entries = [
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
    }),
    entry({
      type: "message",
      message: { role: "toolResult", usage: usage(3, 1, 4, 1, 0.02) },
    }),
    entry({ type: "compaction", usage: usage(2, 1, 0, 2, 0.03) }),
    entry({ type: "branch_summary", usage: usage(1, 1, 1, 0, 0.04) }),
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01) },
    }),
  ];

  const result = summarizeFooterUsage(entries);
  assert.deepEqual(
    { ...result, cost: undefined },
    {
      input: 96,
      output: 9,
      cacheRead: 55,
      cacheWrite: 8,
      cost: undefined,
      latestCacheHitRate: 20,
    },
  );
  assert.ok(Math.abs(result.cost - 0.2) < Number.EPSILON);
});

test("a latest zero-prompt assistant clears the rate without clearing cumulative cache totals", () => {
  const result = summarizeFooterUsage([
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(10, 2, 30, 5, 0.1) },
    }),
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(0, 0, 0, 0, 0) },
    }),
  ]);

  assert.equal(result.cacheRead, 30);
  assert.equal(result.cacheWrite, 5);
  assert.equal(result.latestCacheHitRate, undefined);
});

test("sessions without cache activity retain zero cache totals and a zero latest rate", () => {
  assert.deepEqual(
    summarizeFooterUsage([
      entry({
        type: "message",
        message: { role: "assistant", usage: usage(25, 5, 0, 0, 0.01) },
      }),
    ]),
    {
      input: 25,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      latestCacheHitRate: 0,
    },
  );
});

test("incremental usage updates replace keyed assistant turns and rebuild branch summaries", () => {
  const accumulator = new FooterUsageAccumulator();
  const first = { role: "assistant", responseId: "response-1", usage: usage(10, 2, 30, 5, 0.1) } as const;
  accumulator.reset([
    entry({ type: "message", message: first }),
    entry({ type: "compaction", usage: usage(2, 1, 0, 2, 0.03) }),
  ]);
  assert.deepEqual(accumulator.snapshot(), {
    input: 12,
    output: 3,
    cacheRead: 30,
    cacheWrite: 7,
    cost: 0.13,
    latestCacheHitRate: 66.66666666666666,
  });

  accumulator.updateMessage({
    ...first,
    usage: usage(20, 4, 0, 0, 0.2),
  } as never);
  assert.deepEqual(accumulator.snapshot(), {
    input: 22,
    output: 5,
    cacheRead: 0,
    cacheWrite: 2,
    cost: 0.23,
    latestCacheHitRate: 0,
  });

  accumulator.reset([
    entry({ type: "branch_summary", usage: usage(1, 1, 1, 0, 0.04) }),
    entry({
      type: "message",
      message: { role: "assistant", responseId: "response-2", usage: usage(5, 1, 4, 0, 0.05) },
    }),
  ]);
  assert.equal(accumulator.snapshot().input, 6);
  assert.equal(accumulator.snapshot().latestCacheHitRate, 44.44444444444444);
});

test("scopes provider response IDs and repeated tool-call IDs by runtime turn", () => {
  const accumulator = new FooterUsageAccumulator();
  const assistant = (provider: string, cost: number) =>
    ({
      role: "assistant",
      provider,
      api: "openai-responses",
      model: "same-model",
      responseId: "provider-local-id",
      usage: usage(10, 2, 0, 0, cost),
    }) as never;
  accumulator.updateMessage(assistant("provider-a", 0.1));
  accumulator.updateMessage(assistant("provider-b", 0.2));
  accumulator.beginTurn();
  accumulator.updateMessage({ role: "toolResult", toolCallId: "call-1", usage: usage(3, 1, 0, 0, 0.03) } as never);
  accumulator.beginTurn();
  accumulator.updateMessage({ role: "toolResult", toolCallId: "call-1", usage: usage(4, 1, 0, 0, 0.04) } as never);
  assert.equal(accumulator.snapshot().input, 27);
  assert.ok(Math.abs(accumulator.snapshot().cost - 0.37) < Number.EPSILON);
});

test("scopes repeated historical tool-call IDs by assistant turn", () => {
  const accumulator = new FooterUsageAccumulator();
  accumulator.reset([
    entry({ type: "message", message: { role: "assistant", usage: usage(10, 1, 0, 0, 0.1) } }),
    entry({ type: "message", message: { role: "toolResult", toolCallId: "call-1", usage: usage(3, 1, 0, 0, 0.03) } }),
    entry({ type: "message", message: { role: "assistant", usage: usage(20, 2, 0, 0, 0.2) } }),
    entry({ type: "message", message: { role: "toolResult", toolCallId: "call-1", usage: usage(4, 1, 0, 0, 0.04) } }),
  ]);
  assert.equal(accumulator.snapshot().input, 37);
  assert.ok(Math.abs(accumulator.snapshot().cost - 0.37) < Number.EPSILON);
});

test("anonymous assistant updates replace clones within a turn and accumulate across turns", () => {
  const accumulator = new FooterUsageAccumulator();
  accumulator.beginTurn();
  accumulator.updateMessage({ role: "assistant", usage: usage(10, 2, 3, 1, 0.1) } as never);
  accumulator.updateMessage({ role: "assistant", usage: usage(20, 4, 0, 0, 0.2) } as never);
  assert.equal(accumulator.snapshot().input, 20);
  assert.equal(accumulator.snapshot().cost, 0.2);

  accumulator.beginTurn();
  accumulator.updateMessage({ role: "assistant", usage: usage(5, 1, 0, 0, 0.05) } as never);
  assert.equal(accumulator.snapshot().input, 25);
  assert.equal(accumulator.snapshot().cost, 0.25);
});
