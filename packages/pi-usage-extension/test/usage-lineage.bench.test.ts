import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { parseSessionBuffer } from "../data.ts";

/** Bounded 6 MiB fixtures: canonical Pi headers versus imported late metadata. */
test("large skipped entries stop at canonical lineage headers, with a late-metadata fallback", async (t) => {
  const content = "x".repeat(512 * 1024);
  const first = JSON.stringify({
    type: "message",
    id: "first",
    parentId: null,
    timestamp: "2026-07-15T09:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "before" }],
      provider: "anthropic",
      model: "m",
      usage: { input: 1000, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { total: 1 } },
    },
  });
  const edit = JSON.stringify({
    type: "context_edit",
    id: "edit",
    parentId: "first",
    targetId: "first",
    replacement: null,
  });
  const next = (parentId: string) =>
    JSON.stringify({
      type: "message",
      id: "next",
      parentId,
      message: {
        role: "assistant",
        content: [],
        provider: "anthropic",
        model: "m",
        usage: { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } },
      },
    });
  const fixture = (late: boolean) => {
    let parentId = "edit";
    const lines = [JSON.stringify({ type: "session", id: "benchmark" }), first, edit];
    for (let index = 0; index < 12; index++) {
      const id = `skip-${index}`;
      lines.push(
        late
          ? JSON.stringify({ type: "custom", data: { content }, id, parentId })
          : JSON.stringify({
              type: "message",
              id,
              parentId,
              message: { role: "toolResult", content: [{ type: "text", text: content }] },
            }),
      );
      parentId = id;
    }
    lines.push(next(parentId));
    return Buffer.from(lines.join("\n"));
  };
  const canonical = fixture(false);
  const late = fixture(true);
  assert.ok(canonical.length < 7 * 1024 * 1024 && late.length < 7 * 1024 * 1024);
  for (const buffer of [canonical, late]) {
    const parsed = await parseSessionBuffer(buffer);
    assert.equal(parsed.sessionId, "benchmark");
    assert.deepEqual(
      parsed.messages.map((m) => [m.sourceId, m.previousAssistantId, Boolean(m.afterContextEdit)]),
      [
        ["first", "", false],
        ["next", "first", true],
      ],
    );
  }
  // Report several runs; timing noise must not fail CI.
  const elapsed = async (buffer: Buffer) => {
    const start = performance.now();
    await parseSessionBuffer(buffer);
    return performance.now() - start;
  };
  const canonicalTimes: number[] = [];
  const lateTimes: number[] = [];
  for (let run = 0; run < 4; run++) {
    canonicalTimes.push(await elapsed(canonical));
    lateTimes.push(await elapsed(late));
  }
  t.diagnostic(
    `6 MiB skipped-entry parse, canonical: ${canonicalTimes.join(", ")}ms; late metadata: ${lateTimes.join(", ")}ms`,
  );
});

/** Repeated compactions retaining the same edit set should share its tree. */
test("kept edit sets scale across repeated compactions", async (t) => {
  const first = JSON.stringify({
    type: "message",
    id: "first",
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "before" }],
      provider: "anthropic",
      model: "m",
      usage: { input: 1000, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { total: 1 } },
    },
  });
  for (const count of [300, 1200, 2400]) {
    const lines = [JSON.stringify({ type: "session", id: "compactions" }), first];
    let parentId = "first";
    lines.push(
      JSON.stringify({ type: "context_edit", id: "first-edit", parentId, targetId: "first", replacement: null }),
    );
    parentId = "first-edit";
    for (let index = 0; index < count; index++) {
      const targetId = `user-${index}`;
      const editId = `edit-${index}`;
      const compactId = `compact-${index}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id: targetId,
          parentId,
          message: { role: "user", content: [{ type: "text", text: `prompt-${index}` }] },
        }),
      );
      lines.push(JSON.stringify({ type: "context_edit", id: editId, parentId: targetId, targetId, replacement: null }));
      lines.push(
        JSON.stringify({
          type: "compaction",
          id: compactId,
          parentId: editId,
          firstKeptEntryId: "first",
          summary: "summary",
        }),
      );
      parentId = compactId;
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id: "after-compact",
        parentId,
        message: {
          role: "assistant",
          content: [],
          provider: "anthropic",
          model: "m",
          usage: { input: 1000, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { total: 1 } },
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "context_edit",
        id: "restore-first",
        parentId: "after-compact",
        targetId: "first",
        replacement: { content: [{ type: "text", text: "before" }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: "last",
        parentId: "restore-first",
        message: {
          role: "assistant",
          content: [],
          provider: "anthropic",
          model: "m",
          usage: { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } },
        },
      }),
    );
    const buffer = Buffer.from(lines.join("\n"));
    const start = performance.now();
    const parsed = await parseSessionBuffer(buffer);
    const elapsed = performance.now() - start;
    assert.deepEqual(
      parsed.messages.map((m) => [m.sourceId, Boolean(m.afterContextEdit), m.afterCompaction]),
      [
        ["first", false, false],
        ["after-compact", false, true],
        ["last", true, false],
      ],
    );
    t.diagnostic(
      `${count} kept edits/compactions, ${(buffer.length / 1024 / 1024).toFixed(2)} MiB: ${elapsed.toFixed(1)}ms`,
    );
  }
});

/** Runs through the measured regression sizes without binding CI to timer noise. */
test("context edit lineage scales for repeated and growing target sets", async (t) => {
  const first = JSON.stringify({
    type: "message",
    id: "first",
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "before" }],
      provider: "anthropic",
      model: "m",
      usage: { input: 1000, output: 1, cacheRead: 100_000, cacheWrite: 0, cost: { total: 1 } },
    },
  });
  const fixture = (count: number, distinct: boolean) => {
    const lines = [JSON.stringify({ type: "session", id: "edits" }), first];
    let parentId = "first";
    for (let index = 0; index < count; index++) {
      const targetId = distinct ? `target-${index}` : "first";
      if (distinct) {
        lines.push(
          JSON.stringify({
            type: "message",
            id: targetId,
            parentId,
            message: { role: "user", content: [{ type: "text", text: `prompt-${index}` }] },
          }),
        );
        parentId = targetId;
      }
      const id = `edit-${index}`;
      lines.push(
        JSON.stringify({
          type: "context_edit",
          id,
          parentId,
          targetId,
          replacement: distinct ? null : { content: index % 2 === 0 ? "changed" : "before" },
        }),
      );
      parentId = id;
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id: "last",
        parentId,
        message: {
          role: "assistant",
          content: [],
          provider: "anthropic",
          model: "m",
          usage: { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } },
        },
      }),
    );
    return Buffer.from(lines.join("\n"));
  };
  for (const distinct of [false, true]) {
    const mode = distinct ? "growing distinct targets" : "alternating same target";
    for (const count of [500, 4000, 8000, 16_000]) {
      const buffer = fixture(count, distinct);
      const start = performance.now();
      const parsed = await parseSessionBuffer(buffer);
      const elapsed = performance.now() - start;
      assert.deepEqual(
        parsed.messages.map((m) => m.sourceId),
        ["first", "last"],
      );
      assert.equal(Boolean(parsed.messages[1]?.afterContextEdit), false);
      t.diagnostic(`${mode}, ${count} edits, ${(buffer.length / 1024 / 1024).toFixed(2)} MiB: ${elapsed.toFixed(1)}ms`);
    }
  }
});
