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
    entry({ id: "warm-1", type: "usage", kind: "cache_warm", usage: usage(4, 1, 6, 1, 0.05) }),
    entry({
      type: "message",
      message: { role: "assistant", usage: usage(80, 4, 20, 0, 0.01) },
    }),
  ];

  const result = summarizeFooterUsage(entries);
  assert.deepEqual(
    { ...result, cost: undefined },
    {
      input: 100,
      output: 10,
      cacheRead: 61,
      cacheWrite: 9,
      cost: undefined,
      latestCacheHitRate: 20,
    },
  );
  assert.ok(Math.abs(result.cost - 0.25) < Number.EPSILON);
});

test("standalone usage is picked up once and survives navigation without leaking across restarts", () => {
  const accumulator = new FooterUsageAccumulator();
  const assistant = entry({
    type: "message",
    message: { role: "assistant", usage: usage(10, 2, 30, 0, 0.1) },
  });
  const warm = entry({ id: "warm-1", type: "usage", kind: "cache_warm", usage: usage(1, 1, 5, 2, 0.05) });
  const other = entry({ id: "other-1", type: "usage", kind: "other", usage: usage(2, 1, 3, 0, 0.02) });

  accumulator.reset([assistant]);
  assert.equal(accumulator.updateUsageEntries([assistant, warm]), true);
  assert.equal(accumulator.updateUsageEntries([assistant, warm]), false);
  assert.deepEqual(accumulator.snapshot(), {
    input: 11,
    output: 3,
    cacheRead: 35,
    cacheWrite: 2,
    cost: 0.15000000000000002,
    latestCacheHitRate: 75,
  });

  // getEntries includes abandoned branches; a tree rebuild must not count their usage twice.
  accumulator.reset([assistant, warm, other]);
  assert.equal(accumulator.updateUsageEntries([assistant, warm, other]), false);
  assert.equal(accumulator.snapshot().input, 13);
  assert.equal(accumulator.snapshot().cost, 0.17);
  assert.equal(accumulator.snapshot().latestCacheHitRate, 75);

  accumulator.reset([]);
  assert.equal(accumulator.updateUsageEntries([warm]), true);
  assert.equal(accumulator.snapshot().cost, 0.05);
});

test("new usage checks inspect only entries appended since the last rebuild", () => {
  const accumulator = new FooterUsageAccumulator();
  const old = entry({ id: "old", type: "usage", usage: usage(10, 1, 0, 0, 0.1) });
  const warm = entry({ id: "new", type: "usage", usage: usage(2, 1, 3, 0, 0.02) });
  accumulator.reset([old]);
  const entries = [old, warm];
  Object.defineProperty(entries, 0, {
    get() {
      throw new Error("previously scanned entries should not be visited again");
    },
  });

  assert.equal(accumulator.updateUsageEntries(entries), true);
  assert.equal(accumulator.snapshot().input, 12);
  assert.equal(accumulator.updateUsageEntries(entries), false);
  assert.equal(accumulator.snapshot().cost, 0.12000000000000001);
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
