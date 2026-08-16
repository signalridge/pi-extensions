import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { checkpointMarkerVariants } from "../src/checkpoint.js";
import {
  appendCompactionTrigger,
  CodexCompactionProtocolError,
  collectCompactionSse,
  hasCheckpointMarker,
  prepareRemoteCompactionPayload,
  rewriteCheckpointMarker,
} from "../src/protocol.js";

const encoder = new TextEncoder();

function fragmentedStream(text: string, chunkSize = 1): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.slice(index, index + chunkSize));
      }
      controller.close();
    },
  });
}

function validSse(item = { type: "compaction", encrypted_content: "opaque" }): string {
  return [
    ": keepalive\r\n",
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\r\n\r\n`,
  ].join("");
}

test("collects one compaction from fragmented CRLF SSE and deduplicates completed output", async () => {
  const result = await collectCompactionSse(fragmentedStream(validSse()));
  assert.deepEqual(result.item, { type: "compaction", encrypted_content: "opaque" });
  assert.ok(result.completedResponse);
});

test("joins multiline data fields and ignores unrelated events", async () => {
  const outputItem = JSON.stringify({
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "opaque" },
  });
  const stream = fragmentedStream(
    `data: ${outputItem}\n\ndata: {"type":"response.completed",\ndata: "response":{"output":[]}}\n\n`,
    3,
  );
  const result = await collectCompactionSse(stream);
  assert.equal(result.item.encrypted_content, "opaque");
});

describe("rejects incomplete, missing, duplicate, malformed, empty, oversized, and aborted streams", () => {
  test("missing completion", async () => {
    await assert.rejects(
      collectCompactionSse(
        fragmentedStream(
          'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"x"}}\n\n',
        ),
      ),
      /without response.completed/,
    );
  });
  test("missing item", async () => {
    await assert.rejects(
      collectCompactionSse(fragmentedStream('data: {"type":"response.completed","response":{"output":[]}}\n\n')),
      /returned 0 distinct/,
    );
  });
  test("duplicate items", async () => {
    const text = [
      'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"a"}}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"compaction","encrypted_content":"b"}]}}\n\n',
    ].join("");
    await assert.rejects(collectCompactionSse(fragmentedStream(text)), /returned 2 distinct/);
  });
  test("malformed JSON", async () => {
    await assert.rejects(collectCompactionSse(fragmentedStream("data: {nope}\n\n")), /malformed SSE/);
  });
  test("empty content", async () => {
    await assert.rejects(
      collectCompactionSse(fragmentedStream(validSse({ type: "compaction", encrypted_content: "" }))),
      /valid compaction/,
    );
  });
  test("oversized item", async () => {
    await assert.rejects(collectCompactionSse(fragmentedStream(validSse()), { maxItemBytes: 10 }), /size limit/);
  });
  test("oversized stream", async () => {
    await assert.rejects(collectCompactionSse(fragmentedStream(validSse()), { maxBytes: 10 }), /stream exceeded/);
  });
  test("abort", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectCompactionSse(fragmentedStream(validSse()), { signal: controller.signal }), /aborted/i);
  });
  test("abort while waiting for the next chunk", async () => {
    const controller = new AbortController();
    const pending = collectCompactionSse(new ReadableStream<Uint8Array>({}), {
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending, /aborted/i);
  });
});

test("rewrites exactly one marker and appends exactly one final trigger", () => {
  const marker = "checkpoint";
  const payload = {
    model: "gpt",
    input: [
      { role: "user", content: [{ type: "input_text", text: marker }] },
      { role: "user", content: [{ type: "input_text", text: "later" }] },
    ],
  };
  const replacement = [
    { role: "user", content: [{ type: "input_text", text: "old" }] },
    { type: "compaction", encrypted_content: "opaque" },
  ];
  const prepared = prepareRemoteCompactionPayload(payload, {
    marker,
    replacementHistory: replacement,
  });
  assert.deepEqual(prepared.input, [...replacement, payload.input[1], { type: "compaction_trigger" }]);
  assert.equal(payload.input.length, 2, "does not mutate caller payload");
});

test("rewrites a legacy package marker after reload", () => {
  const markers = checkpointMarkerVariants("checkpoint-legacy");
  const payload = {
    input: [{ role: "user", content: [{ type: "input_text", text: markers[1] }] }],
  };
  assert.equal(hasCheckpointMarker(payload, markers), true);
  const rewritten = rewriteCheckpointMarker(payload, markers, [{ type: "compaction", encrypted_content: "opaque" }]);
  assert.equal(rewritten.input[0]?.type, "compaction");
});

test("payload validators reject malformed inputs, missing/duplicate markers, and duplicate triggers", () => {
  assert.throws(() => appendCompactionTrigger({}), CodexCompactionProtocolError);
  assert.throws(() => rewriteCheckpointMarker({ input: [] }, "x", []), /0 checkpoint markers/);
  const markerItem = { role: "user", content: [{ type: "input_text", text: "x" }] };
  assert.throws(() => rewriteCheckpointMarker({ input: [markerItem, markerItem] }, "x", []), /2 checkpoint markers/);
  assert.throws(() => appendCompactionTrigger({ input: [{ type: "compaction_trigger" }] }), /already contains/);
});
