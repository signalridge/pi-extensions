import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { createAssistantMessageEventStream, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { test, vi } from "vitest";
import { requestBoundedCompaction } from "../src/bounded-compaction.js";
import { buildReplacementHistory } from "../src/checkpoint.js";
import { type CompactionFailureCode, failureFrom } from "../src/failure.js";
import type { JsonObject } from "../src/protocol.js";
import { requestRemoteCompaction } from "../src/remote.js";
import { planWireSegments } from "../src/wire-segments.js";

const model = {
  id: "offline",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<"openai-codex-responses">;
const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};
const user = (text: string): JsonObject => ({ role: "user", content: [{ type: "input_text", text }] });
const opaque = (text = "prior"): JsonObject => ({ type: "compaction", encrypted_content: text });
const users = () => Array.from({ length: 6 }, (_, i) => user(`${i}${"x".repeat(1000)}`));
const response = (item = opaque("next")) =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
  );
const overflow = () =>
  new Response(
    'data: {"type":"response.failed","response":{"error":{"code":"context_window_exceeded","message":"SECRET"}}}\n\n',
  );
const fails = (code: CompactionFailureCode) => (error: unknown) => {
  assert.equal(failureFrom(error, "local_compaction_failed").code, code);
  assert.ok(!String(error).includes("SECRET"));
  return true;
};

type Options = NonNullable<Parameters<Provider["stream"]>[2]>;
function providerFor(payload: () => JsonObject, hook?: (options: Options, body: unknown) => Promise<void>): Provider {
  return {
    id: "openai-codex",
    name: "Offline",
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(_model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop" as const,
        timestamp: 0,
      };
      void (async () => {
        try {
          const body = await options?.onPayload?.(payload(), model);
          if (hook) {
            assert.ok(options);
            await hook(options, body);
          } else
            await (
              await options?.fetch?.("https://example.test", { method: "POST", body: JSON.stringify(body) })
            )?.text();
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        } catch {
          stream.push({
            type: "error",
            reason: "error",
            error: { ...message, stopReason: "error", errorMessage: "SECRET" },
          });
          stream.end();
        }
      })();
      return stream;
    },
    streamSimple() {
      throw new Error("unused");
    },
  };
}
function setup(input: JsonObject[], extra: Partial<Parameters<typeof requestBoundedCompaction>[0]> = {}) {
  const packets: JsonObject[] = [];
  const request = {
    provider: providerFor(() => ({ instructions: "canonical", tools: [], input })),
    model,
    context: { messages: [] },
    signal: new AbortController().signal,
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      packets.push(JSON.parse(String(init?.body)) as JsonObject);
      return response(opaque(`fold-${packets.length}`));
    },
    ...extra,
  };
  return { packets, request };
}

for (const total of [undefined, 300_000]) {
  test(`five healthy 70s folds respect total ${total ?? "default"}`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      let calls = 0;
      const input = Array.from({ length: 5 }, (_, i) => user(`${i}${"x".repeat(2000)}`));
      const { request } = setup(input, {
        requestTimeoutMs: total,
        fetch: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 70_000));
          return response(opaque(`fold-${calls}`));
        },
      });
      const pending = requestBoundedCompaction(request);
      const checked =
        total === undefined
          ? pending.then((result) => assert.deepEqual(result.promptInput, input))
          : assert.rejects(pending, fails("remote_timeout"));
      void checked.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(350_000);
      await checked;
      assert.equal(calls, 5);
    } finally {
      vi.useRealTimers();
    }
  });
}

test("one stalled stage expires at five minutes despite a fifteen minute total", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    let signal: AbortSignal | undefined;
    const { request } = setup(users(), {
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      },
    });
    let settled = false;
    const checked = assert.rejects(requestBoundedCompaction(request), fails("remote_timeout")).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(299_999);
    assert.equal(settled, false);
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    assert.equal(signal?.aborted, true);
  } finally {
    vi.useRealTimers();
  }
});

test("folds contiguous occurrence indices, repeats exact prefix groups, preserves complete backups", async () => {
  const declarations = [
    { type: "additional_tools", role: "developer", tools: [{ name: "a" }] },
    { type: "additional_tools", role: "developer", tools: [{ name: "b" }] },
  ];
  const duplicate = user("equal".repeat(200));
  const conversation = [
    user("older unsent summary"),
    user("backup"),
    opaque(),
    duplicate,
    structuredClone(duplicate),
    ...users(),
  ];
  const input = [...declarations, ...conversation];
  const { request, packets } = setup(input);
  const result = await requestBoundedCompaction(request);
  assert.ok(packets.length > 1);
  const absorbed: unknown[] = [];
  for (const [i, packet] of packets.entries()) {
    const selection = packet.input as JsonObject[];
    assert.deepEqual(selection.slice(0, 2), declarations);
    assert.deepEqual(selection.at(-1), { type: "compaction_trigger" });
    const items = selection.slice(2, -1);
    assert.equal(items.filter((item) => item.type === "compaction").length, 1);
    if (i) assert.deepEqual(items.shift(), opaque(`fold-${i}`));
    absorbed.push(...items);
  }
  assert.deepEqual(absorbed, conversation);
  assert.deepEqual(result.promptInput, input);
  assert.equal(result.usage.totalTokens, packets.length * 12);
  assert.equal(result.usage.cost.total, packets.length * 3);
  const replacement = buildReplacementHistory(result.promptInput, result.item);
  assert.deepEqual(
    replacement.filter((item) => item.role === "user"),
    conversation.filter((item) => item.role === "user"),
  );
});

test("a single remote fold reports only the input actually submitted", async () => {
  const input = [user("sent prefix"), user("unsent suffix")];
  const { request, packets } = setup(input);
  const result = await requestRemoteCompaction({ ...request, selectInput: (original) => original.slice(0, 1) });
  assert.deepEqual((packets[0].input as JsonObject[]).slice(0, -1), input.slice(0, 1));
  assert.deepEqual(result.promptInput, input.slice(0, 1));
});

test("planner closes parallel results and sequential tool rounds, never splits adjacent reasoning", () => {
  const reasoning = { type: "reasoning", summary: [] };
  const call = (id: string) => ({ type: "function_call", call_id: id, name: "tool", arguments: "{}" });
  const out = (id: string) => ({ type: "function_call_output", call_id: id, output: "ok" });
  const input = [user("task"), reasoning, reasoning, call("a"), call("b"), out("a"), out("b"), call("c"), out("c")];
  assert.deepEqual(planWireSegments(input), { prefixEnd: 0, ends: [7, 9] });
  for (const invalid of [
    [call("a")],
    [out("a")],
    [call("a"), out("a"), out("a")],
    [call("a"), out("a"), call("a"), out("a")],
  ]) {
    assert.throws(() => planWireSegments(invalid), fails("segmentation_unsupported"));
  }
});

test("structured overflow shrinks only to earlier closed boundaries", async () => {
  const input = users().slice(0, 3);
  const { request } = setup(input, { model: { ...model, contextWindow: 100_000 } });
  const packets: JsonObject[][] = [];
  request.fetch = async (_url, init) => {
    packets.push((JSON.parse(String(init?.body)) as { input: JsonObject[] }).input);
    return packets.length === 1 ? overflow() : response();
  };
  const result = await requestBoundedCompaction(request);
  assert.deepEqual(result.promptInput, input);
  assert.ok(packets[1].length < packets[0].length);
  const firstEnd = packets[1].length - 1;
  assert.deepEqual(packets[1].slice(0, -1), input.slice(0, firstEnd));
  assert.deepEqual(packets[2].slice(1, -1), input.slice(firstEnd));
});

test("overflow halves many small closed groups rather than removing one per attempt", async () => {
  const input = Array.from({ length: 50 }, (_, i) => user(`${i}${"x".repeat(100)}`));
  const { request } = setup(input, { model: { ...model, contextWindow: 100_000 } });
  const counts: number[] = [];
  request.fetch = async (_url, init) => {
    const packet = JSON.parse(String(init?.body)) as { input: JsonObject[] };
    const count = packet.input.filter((item) => item.role === "user").length;
    counts.push(count);
    return count > 25 ? overflow() : response();
  };
  const result = await requestBoundedCompaction(request);
  assert.deepEqual(result.promptInput, input);
  assert.equal(counts[0], 50);
  assert.ok(counts[1] <= 25 && counts[1] >= 20, String(counts));
  assert.ok(counts.length <= 5, String(counts));
});

test("minimum atomic overflow is never retried identically", async () => {
  let sent = 0;
  const { request } = setup([user("x".repeat(5000))], {
    fetch: async () => {
      sent++;
      return overflow();
    },
  });
  await assert.rejects(requestBoundedCompaction(request), fails("remote_context_window_exceeded"));
  assert.equal(sent, 1);
});

for (const invalid of [
  [{ type: "item_reference", id: "unknown" }],
  [user("first"), { type: "additional_tools", role: "developer", tools: [] }],
  [{ type: "function_call_output", call_id: "orphan", output: "SECRET" }],
  [opaque(), opaque()],
]) {
  test(`unsupported segmented shape ${JSON.stringify(invalid)} sends nothing`, async () => {
    const { request, packets } = setup([...invalid, ...users()]);
    await assert.rejects(requestBoundedCompaction(request), fails("segmentation_unsupported"));
    assert.equal(packets.length, 0);
  });
}

test("small late declarations remain single-call compatible", async () => {
  const { request, packets } = setup([user("first"), { type: "additional_tools", role: "developer", tools: [] }]);
  await requestBoundedCompaction(request);
  assert.equal(packets.length, 1);
});

for (const failureStage of [1, 2, 3]) {
  test(`failure at stage ${failureStage} never returns a partial result`, async () => {
    let count = 0;
    const { request } = setup(users(), {
      fetch: async () => (++count === failureStage ? new Response("SECRET", { status: 400 }) : response()),
    });
    await assert.rejects(requestBoundedCompaction(request), fails("remote_http_error"));
    assert.equal(count, failureStage);
  });
}

test("shared hard cap covers malicious provider retry loops", async () => {
  let sends = 0;
  const provider = providerFor(
    () => ({ input: users() }),
    async (options, body) => {
      for (let i = 0; i < 20; i++) {
        try {
          await options.fetch?.("https://example.test", { method: "POST", body: JSON.stringify(body) });
        } catch {}
      }
    },
  );
  const { request } = setup([], {
    provider,
    fetch: async () => {
      sends++;
      return new Response("SECRET", { status: 503 });
    },
  });
  await assert.rejects(requestBoundedCompaction(request), fails("remote_attempt_budget_exhausted"));
  assert.equal(sends, 8);
});

for (const mode of ["mutate", "no-body", "zstd-mutate", "zstd-bomb", "zstd-ok"] as const) {
  test(`strict body verification: ${mode}`, async () => {
    let sends = 0;
    const provider = providerFor(
      () => ({ input: [user("task")] }),
      async (options, body) => {
        const text = JSON.stringify(body);
        await (
          await options.fetch?.("https://example.test", {
            method: "POST",
            headers: mode.startsWith("zstd") ? { "content-encoding": "zstd" } : undefined,
            body:
              mode === "no-body"
                ? undefined
                : mode === "mutate"
                  ? `${text} `
                  : new Uint8Array(
                      zlib.zstdCompressSync(
                        mode === "zstd-bomb" ? "x".repeat(9 * 1024 * 1024) : mode === "zstd-mutate" ? `${text} ` : text,
                      ),
                    ),
          })
        )?.text();
      },
    );
    const { request } = setup([], {
      provider,
      fetch: async () => {
        sends++;
        return response();
      },
    });
    if (mode === "zstd-ok") {
      await requestBoundedCompaction(request);
      assert.equal(sends, 1);
    } else {
      await assert.rejects(requestBoundedCompaction(request), fails("payload_rejected"));
      assert.equal(sends, 0);
    }
  });
}

for (const mode of ["input", "headers", "stream", "ownership"] as const) {
  test(`between-stage ${mode} drift blocks the next send`, async () => {
    let current = true;
    const input = users();
    const { request, packets } = setup(input, { headers: { "X-Auth": "first" }, isCurrent: () => current });
    const transport = request.fetch;
    request.fetch = async (url, init) => {
      const result = await transport(url, init);
      if (mode === "input") input.push(user("changed"));
      if (mode === "headers") {
        assert.ok(request.headers);
        request.headers["X-Auth"] = "SECRET";
      }
      if (mode === "stream")
        request.provider.stream = () => {
          throw new Error("SECRET");
        };
      if (mode === "ownership") current = false;
      return result;
    };
    await assert.rejects(requestBoundedCompaction(request));
    assert.equal(packets.length, 1);
  });
}

test("missing onPayload and swallowed validation failures cannot dispatch", async () => {
  for (const mode of ["missing", "swallowed"] as const) {
    let sent = 0;
    const payload = { instructions: "canonical", input: [user("task")] };
    const inner = providerFor(
      () => payload,
      async (options, body) => {
        if (mode === "swallowed") {
          try {
            await options.onPayload?.({ ...payload, instructions: "SECRET" }, model);
          } catch {}
        }
        try {
          await options.fetch?.("https://example.test", { body: JSON.stringify(body ?? payload) });
        } catch {}
      },
    );
    const provider: Provider = {
      ...inner,
      stream: (model, context, options) =>
        inner.stream(model, context, mode === "missing" ? { ...options, onPayload: undefined } : options),
    };
    const { request } = setup([], {
      provider,
      validatePayload: (value) => (value as JsonObject).instructions === "canonical",
      fetch: async () => {
        sent++;
        return response();
      },
    });
    await assert.rejects(
      requestBoundedCompaction(request),
      fails(mode === "missing" ? "payload_rejected" : "loadout_mismatch"),
    );
    assert.equal(sent, 0);
  }
});

test("selected payload is revalidated, not only its original complete envelope", async () => {
  const { request, packets } = setup(users(), {
    validatePayload: (payload) =>
      !((payload as JsonObject).input as JsonObject[]).some((item) => item.type === "compaction_trigger") ||
      ((payload as JsonObject).input as JsonObject[]).length === 7,
  });
  await assert.rejects(requestBoundedCompaction(request), fails("loadout_mismatch"));
  assert.equal(packets.length, 0);
});

test("eight attempts are shared across successful folds, never eight per stage", async () => {
  const { request, packets } = setup(Array.from({ length: 20 }, (_, i) => user(`${i}${"x".repeat(1000)}`)));
  await assert.rejects(requestBoundedCompaction(request), fails("remote_attempt_budget_exhausted"));
  assert.equal(packets.length, 8);
});

test("initialization getters and toJSON failures are closed and credential-safe", async () => {
  for (const mode of ["model", "toJSON", "stream"] as const) {
    const { request, packets } = setup([user("task")]);
    const fail = () => {
      throw new Error("SECRET credential");
    };
    if (mode === "model") Object.defineProperty(request, "model", { get: fail });
    if (mode === "toJSON") Object.defineProperty(request.model, "toJSON", { configurable: true, value: fail });
    if (mode === "stream") Object.defineProperty(request.provider, "stream", { get: fail });
    try {
      await assert.rejects(requestBoundedCompaction(request), fails("payload_rejected"));
    } finally {
      if (mode === "toJSON") Reflect.deleteProperty(model, "toJSON");
    }
    assert.equal(packets.length, 0);
  }
});

test("RequestInit body accessors cannot swap approved text at dispatch", async () => {
  let reads = 0;
  const { request, packets } = setup([], {
    provider: providerFor(
      () => ({ input: [user("task")] }),
      async (options, body) => {
        await options.fetch?.("https://example.test", {
          get body() {
            return ++reads < 3 ? JSON.stringify(body) : "SECRET unselected history";
          },
        });
      },
    ),
  });
  await assert.rejects(requestBoundedCompaction(request), fails("payload_rejected"));
  assert.equal(reads, 0);
  assert.equal(packets.length, 0);
});

test("beforeFetch cannot mutate dispatch-owned approved body or headers", async () => {
  let body: unknown;
  let headers: Headers | undefined;
  const { request } = setup([user("task")], {
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return response();
    },
  });
  await requestRemoteCompaction({
    ...request,
    selectInput: (input) => input,
    beforeFetch: (_url, init) => {
      assert.ok(init);
      init.body = "SECRET original full history";
      (init.headers as Headers).set("Authorization", "SECRET different account");
    },
  });
  assert.deepEqual((body as JsonObject).input, [user("task"), { type: "compaction_trigger" }]);
  assert.equal(headers?.get("Authorization"), null);
});

test("beforeFetch receives a disposable abort signal, not dispatch-owned storage", async () => {
  const { request, packets } = setup([user("task")]);
  await requestRemoteCompaction({
    ...request,
    selectInput: (input) => input,
    beforeFetch: (_url, init) => {
      assert.ok(init?.signal);
      Object.defineProperty(init.signal, "aborted", {
        get: () => {
          throw new Error("SECRET signal getter");
        },
      });
    },
  });
  assert.equal(packets.length, 1);
});

for (const mode of ["ownership", "deadline"] as const) {
  test(`header snapshot side effects recheck ${mode} before dispatch`, async () => {
    let current = true;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const provider = providerFor(
      () => ({ input: [user("task")] }),
      async (options, body) => {
        const headers = {
          *[Symbol.iterator]() {
            if (mode === "ownership") current = false;
            else now = 400_000;
            yield ["X-Header", "value"];
          },
        } as unknown as HeadersInit;
        await options.fetch?.("https://example.test", { headers, body: JSON.stringify(body) });
      },
    );
    const { request, packets } = setup([], { provider, isCurrent: () => current });
    await assert.rejects(requestBoundedCompaction(request));
    assert.equal(packets.length, 0);
  });
}

for (const field of ["method", "cache"] as const) {
  test(`object-valued transport ${field} cannot execute after the no-send gate`, async () => {
    let current = true;
    let sent = 0;
    const coercible = {
      toString: () => {
        current = false;
        return field === "method" ? "POST" : "no-store";
      },
    };
    const provider = providerFor(
      () => ({ input: [user("task")] }),
      async (options, body) => {
        const init = { body: JSON.stringify(body), [field]: coercible } as unknown as RequestInit;
        await options.fetch?.("https://example.test", init);
      },
    );
    const { request } = setup([], {
      provider,
      isCurrent: () => current,
      fetch: async (_url, init) => {
        sent++;
        String(init?.[field]); // Simulate native RequestInit dictionary conversion.
        return response();
      },
    });
    await assert.rejects(requestBoundedCompaction(request));
    assert.equal(sent, 0);
    assert.equal(current, true, "unsupported coercion is never invoked");
  });
}

test("compressed wire size uses the intrinsic length before copying", async () => {
  const body = new Uint8Array(9 * 1024 * 1024);
  Object.defineProperty(body, "byteLength", { get: () => 0 });
  const provider = providerFor(
    () => ({ input: [user("task")] }),
    async (options) => {
      await options.fetch?.("https://example.test", { headers: { "content-encoding": "zstd" }, body });
    },
  );
  const { request, packets } = setup([], { provider });
  await assert.rejects(requestBoundedCompaction(request), fails("payload_rejected"));
  assert.equal(packets.length, 0);
});

test("URL coercion overrides cannot change the pinned native URL", async () => {
  let sent = "";
  const url = new URL("https://example.test/approved");
  url.toString = () => "https://different.test/SECRET";
  const provider = providerFor(
    () => ({ input: [user("task")] }),
    async (options, body) => {
      await (await options.fetch?.(url, { body: JSON.stringify(body) }))?.text();
    },
  );
  const { request } = setup([], {
    provider,
    fetch: async (url) => {
      sent = String(url);
      return response();
    },
  });
  await requestBoundedCompaction(request);
  assert.equal(sent, "https://example.test/approved");
});

test("one deadline spans every stage", async () => {
  let sent = 0;
  const { request } = setup(users(), {
    requestTimeoutMs: 30,
    fetch: async () => {
      sent++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response();
    },
  });
  await assert.rejects(requestBoundedCompaction(request), fails("remote_timeout"));
  assert.ok(sent <= 2);
});

test("native provider preserves serialized tools and canonical instructions across folds", async () => {
  const packets: JsonObject[] = [];
  const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64")}.x`;
  const result = await requestBoundedCompaction({
    provider: openaiCodexProvider(),
    model,
    apiKey,
    maxRetries: 0,
    signal: new AbortController().signal,
    context: {
      systemPrompt: "canonical",
      messages: users().map((_, i) => ({ role: "user", content: `${i}${"x".repeat(1000)}`, timestamp: i })),
    },
    fetch: async (_url, init) => {
      const body = init?.body;
      assert.ok(typeof body === "string" || body instanceof Uint8Array);
      packets.push(
        JSON.parse(typeof body === "string" ? body : zlib.zstdDecompressSync(body).toString("utf8")) as JsonObject,
      );
      return response();
    },
  });
  assert.ok(packets.length > 1);
  assert.equal(result.promptInput.length, 6);
  for (const packet of packets) {
    assert.equal(packet.instructions, "canonical");
    assert.deepEqual(packet.tools, packets[0].tools);
    assert.equal((packet.input as JsonObject[]).filter((item) => item.type === "compaction_trigger").length, 1);
  }
});
