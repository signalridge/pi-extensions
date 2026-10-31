import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { checkpointMarkerVariants } from "../src/checkpoint.js";
import { failureFrom } from "../src/failure.js";
import {
  appendCompactionTrigger,
  CodexCompactionProtocolError,
  collectCompactionSse,
  hasCheckpointMarker,
  MAX_SSE_BYTES,
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

for (const fragmented of [false, true]) {
  test(`invalid UTF-8 cannot be repaired inside opaque content (${fragmented ? "fragmented" : "whole"})`, async () => {
    const prefix = encoder.encode(
      'data: {"type":"response.completed","response":{"output":[{"type":"compaction","encrypted_content":"left',
    );
    const suffix = encoder.encode('right"}]}}\n\n');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix);
    bytes[prefix.length] = 0xff;
    bytes.set(suffix, prefix.length + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (fragmented) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    });
    await assert.rejects(collectCompactionSse(body), CodexCompactionProtocolError);
  });
}

for (const malformed of [undefined, null, [], 0, "completed", true]) {
  test(`terminal response must be an object: ${JSON.stringify(malformed)}`, async () => {
    const item = { type: "compaction", encrypted_content: "opaque" };
    const text = [
      { type: "response.output_item.done", item },
      { type: "response.completed", response: malformed },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    await assert.rejects(collectCompactionSse(fragmentedStream(text)), CodexCompactionProtocolError);
  });
}

test("collects one compaction from fragmented CRLF SSE and deduplicates completed output", async () => {
  const result = await collectCompactionSse(fragmentedStream(validSse()));
  assert.deepEqual(result.item, { type: "compaction", encrypted_content: "opaque" });
  assert.ok(result.completedResponse);
});

for (const type of ["response.completed", "response.done"]) {
  for (const open of [false, true]) {
    test(`${type} collects and deduplicates one bounded item (${open ? "open" : "closed"} source)`, async () => {
      const item = { type: "compaction", encrypted_content: "opaque" };
      const body = [
        { type: "response.output_item.done", item },
        { type, response: { status: "completed", output: [item, item] } },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
        .join("");
      let cancellations = 0;
      const source = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of encoder.encode(body)) controller.enqueue(new Uint8Array([byte]));
            if (!open) controller.close();
          },
          cancel() {
            cancellations++;
          },
        });
      assert.deepEqual((await collectCompactionSse(source())).item, item);
      assert.equal(cancellations, open ? 1 : 0);
      await assert.rejects(collectCompactionSse(source(), { maxItemBytes: 10 }), /size limit/);
      await assert.rejects(collectCompactionSse(source(), { maxBytes: 10 }), /stream exceeded/);
      const distinct = body.replace('"output":[', '"output":[{"type":"compaction","encrypted_content":"other"},');
      await assert.rejects(collectCompactionSse(fragmentedStream(distinct)), /returned 2 distinct/);
    }, 1000);
  }
}

for (const type of ["response.completed", "response.done", "response.incomplete"]) {
  for (const status of ["failed", "cancelled", "incomplete", "in_progress", "unknown", null, 123]) {
    test(`rejects terminal ${type} with status ${status} promptly on an open source`, async () => {
      let cancellations = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type, response: { status, output: [{ type: "compaction", encrypted_content: "opaque" }] } })}\n\n`,
            ),
          );
        },
        cancel() {
          cancellations++;
        },
      });
      await assert.rejects(collectCompactionSse(stream));
      assert.equal(cancellations, 1);
    }, 500);
  }
}

for (const type of ["response.incomplete", "response.failed", "response.cancelled"]) {
  test(`closed ${type} is never a successful checkpoint`, async () => {
    await assert.rejects(
      collectCompactionSse(
        fragmentedStream(
          `data: ${JSON.stringify({ type, response: { output: [{ type: "compaction", encrypted_content: "opaque" }] } })}\n\n`,
        ),
      ),
    );
  });
}

for (const code of ["context_window_exceeded", "context_length_exceeded"]) {
  for (const event of [
    { type: "error", code },
    { type: "error", error: { code } },
    { type: "response.failed", response: { error: { code } } },
  ]) {
    test(`collector maps only the structured ${JSON.stringify(event)} wire code`, async () => {
      await assert.rejects(collectCompactionSse(fragmentedStream(`data: ${JSON.stringify(event)}\n\n`)), (error) => {
        assert.equal(failureFrom(error, "remote_provider_error").code, "remote_context_window_exceeded");
        return true;
      });
    });
  }
}

test("terminal response ends inspection and initiates cancellation without awaiting it", async () => {
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(validSse()));
      // Neither EOF nor the underlying cancellation promise ever arrives.
    },
    cancel() {
      cancellations += 1;
      return new Promise<void>(() => {});
    },
  });
  const result = await collectCompactionSse(stream);
  assert.equal(result.item.encrypted_content, "opaque");
  assert.equal(cancellations, 1);
}, 1000);

test("terminal response validates item count even when the source stays open", async () => {
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"output":[]}}\n\n'));
    },
    cancel() {
      cancellations += 1;
    },
  });
  await assert.rejects(collectCompactionSse(stream), /returned 0 distinct/);
  assert.equal(cancellations, 1);
}, 1000);

test("bounded million-item completed output does not depend on JavaScript argument limits", async () => {
  const item = { type: "compaction", encrypted_content: "opaque" };
  const text = `data: {"type":"response.completed","response":{"output":[${"{},".repeat(1_000_000)}${JSON.stringify(item)}]}}\n\n`;
  assert.ok(Buffer.byteLength(text) < MAX_SSE_BYTES);
  const result = await collectCompactionSse(fragmentedStream(text, text.length));
  assert.deepEqual(result.item, item);
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
