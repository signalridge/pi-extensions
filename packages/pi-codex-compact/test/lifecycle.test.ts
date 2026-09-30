import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
  Type,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  buildSessionProjection,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  parseCheckpointDetails,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const model = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<"openai-codex-responses">;

const usage = {
  input: 20,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 21,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function settingsRuntime(overrides = {}): CodexCompactSettingsRuntime {
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/tmp/test-pi-codex-compact.json",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, ...overrides },
    document: {},
  };
  return {
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async update(patch) {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    async flush() {},
  };
}

function fakeProvider(
  onOptions?: (options: OpenAICodexResponsesOptions) => void,
  onPayload?: (payload: unknown) => void,
): Provider {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(_model, context, options) {
      const codexOptions = options as OpenAICodexResponsesOptions;
      onOptions?.(codexOptions);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const input = context.messages
            .filter((message) => message.role !== "system")
            .map((message) => {
              const content = typeof message.content === "string" ? message.content : message.content[0];
              const text = typeof content === "string" ? content : "text" in content ? content.text : "image";
              return { role: "user", content: [{ type: "input_text", text }] };
            });
          const payload = await options?.onPayload?.({ model: model.id, input }, model);
          onPayload?.(payload);
          assert.deepEqual((payload as { input: unknown[] }).input.at(-1), {
            type: "compaction_trigger",
          });
          const response = await options?.fetch?.("https://example.test", { method: "POST" });
          await response?.text();
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch (error) {
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "error" as const,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      assert.equal(codexOptions.maxRetries, 2);
      return stream;
    },
    streamSimple() {
      throw new Error("not used");
    },
  };
}

function branch(): SessionEntry[] {
  return [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
}

function event(signal = new AbortController().signal): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "assistant",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 123,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: branch(),
    reason: "manual",
    willRetry: false,
    signal,
  };
}

test("effective checkpoint selection recovers remote -> native -> remote and fails closed for current corruption", async () => {
  for (const scenario of [
    "retained",
    "native",
    "native-retains-remote",
    "mismatch",
    "malformed",
    "missing-details",
    "missing-anchor",
    "lineage",
  ] as const) {
    const session = SessionManager.inMemory();
    const oldUser = session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    const keptMessage = { role: "user" as const, content: "kept request", timestamp: 2 };
    const keptId = session.appendMessage(keptMessage);
    const prior = createCheckpointDetails({
      modelId: scenario === "mismatch" ? "other-model" : model.id,
      checkpointId: "checkpoint-prior",
      replacementHistory: [{ type: "compaction", encrypted_content: "prior-opaque" }],
      keptMessages: scenario === "lineage" ? [{ ...keptMessage, content: "wrong lineage" }] : [keptMessage],
    });
    session.appendCompaction(
      scenario === "missing-anchor" ? "wrong anchor" : fallbackSummary(prior.checkpointId),
      keptId,
      123,
      scenario === "malformed"
        ? { ...prior, replacementHistory: [] }
        : scenario === "missing-details"
          ? undefined
          : prior,
      true,
    );
    const laterId = session.appendMessage({ role: "user", content: "later request", timestamp: 3 });
    const native = scenario === "native" || scenario === "native-retains-remote";
    if (native) session.appendCompaction("native context summary", scenario === "native" ? laterId : oldUser, 100);
    const afterId = session.appendMessage({ role: "user", content: "after boundary", timestamp: 4 });
    const mock = createMockPi();
    let requests = 0;
    let sentPayload: unknown;
    createCodexCompactExtension({
      settingsRuntime: settingsRuntime(),
      fetch: async () => {
        requests += 1;
        return sseResponse();
      },
    })(mock.pi);
    const { ctx, notifications, statuses } = createMockContext({
      model,
      hasUI: true,
      getSystemPrompt: () => "",
      sessionManager: session,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-test-key" }),
        getProvider: () =>
          fakeProvider(undefined, (payload) => {
            sentPayload = payload;
          }),
      },
    });
    if (native) {
      const stalePayload = {
        input: [{ role: "user", content: [{ type: "input_text", text: checkpointMarker(prior.checkpointId) }] }],
      };
      assert.equal(
        await mock.events.get("context")?.[0]({ messages: session.buildSessionContext().messages }, ctx),
        undefined,
      );
      assert.equal(await mock.events.get("before_provider_request")?.[0]({ payload: stalePayload }, ctx), undefined);
      await mock.events.get("model_select")?.[0]({ model: { ...model, provider: "other" } }, ctx);
      assert.equal(notifications.length, 0, "superseded checkpoints must not warn about model selection");
    }
    const input = event();
    input.branchEntries = session.getBranch();
    input.preparation.firstKeptEntryId = afterId;
    const result = (await mock.events.get("session_before_compact")?.[0](input, ctx)) as
      | { compaction: { summary: string; details: unknown } }
      | undefined;
    if (native || scenario === "retained") {
      assert.ok(result, scenario);
      assert.equal(requests, 1);
      const next = parseCheckpointDetails(result.compaction.details);
      assert.ok(next);
      assert.equal(JSON.stringify(sentPayload).includes("prior-opaque"), !native);
      if (native) assert.match(JSON.stringify(next.replacementHistory), /native context summary/);
      session.appendCompaction(result.compaction.summary, afterId, 100, next, true);
      const projected = await mock.events.get("context")?.[0](
        { messages: session.buildSessionContext().messages },
        ctx,
      );
      assert.ok(projected, "new remote checkpoint replays after native fallback");
    } else {
      assert.equal(result, undefined, scenario);
      assert.equal(requests, 0, scenario);
      assert.match(notifications.at(-1)?.message ?? "", /using Pi compaction/);
    }
    assert.equal(statuses.get("codex-compact"), undefined);
  }
});

function sseResponse() {
  const item = { type: "compaction", encrypted_content: "opaque" };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("registers the settings command and returns a versioned Remote V2 compaction with usage", async () => {
  const mock = createMockPi();
  let forwardedHeaders: OpenAICodexResponsesOptions["headers"];
  const runtime = settingsRuntime();
  createCodexCompactExtension({ settingsRuntime: runtime, fetch: async () => sseResponse() })(mock.pi);
  assert.ok(mock.commands.has("codex-compact"));
  const handler = mock.events.get("session_before_compact")?.[0];
  assert.ok(handler);
  const entries = branch();
  const { ctx, statuses } = createMockContext({
    model,
    getSystemPrompt: () => "",
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => entries,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "secret-oauth",
        headers: { Authorization: null, "X-Provider-Token": "test" },
      }),
      getProvider: () =>
        fakeProvider((options) => {
          forwardedHeaders = options.headers;
        }),
    },
  });
  const result = (await handler?.(event(), ctx)) as {
    compaction: { usage: unknown; details: unknown; summary: string };
  };
  assert.deepEqual(result.compaction.usage, usage);
  assert.deepEqual(forwardedHeaders, { Authorization: null, "X-Provider-Token": "test" });
  const details = parseCheckpointDetails(result.compaction.details);
  assert.ok(details);
  assert.doesNotMatch(JSON.stringify(details), /secret-oauth/);
  assert.match(result.compaction.summary, /requires @signalridge\/pi-codex-compact/);
  assert.equal(statuses.get("codex-compact"), undefined);

  const kept = entries[1].type === "message" ? entries[1].message : assert.fail("kept message");
  const compactionEntry = {
    type: "compaction" as const,
    id: "compact",
    parentId: "assistant",
    timestamp: "2026-01-01T00:00:02.000Z",
    summary: result.compaction.summary,
    firstKeptEntryId: "assistant",
    tokensBefore: 123,
    details,
  };
  const replayContext = createMockContext({
    model,
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [...entries, compactionEntry],
    },
  }).ctx;
  const summaryMessage = {
    role: "compactionSummary" as const,
    summary: result.compaction.summary,
    tokensBefore: 123,
    timestamp: 3,
  };
  const later = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "later" }],
    timestamp: 4,
  };
  const contextHandler = mock.events.get("context")?.[0];
  const projected = (await contextHandler?.(
    { type: "context", messages: [summaryMessage, kept, later] },
    replayContext,
  )) as { messages: Array<{ content: Array<{ text: string }> }> };
  assert.equal(projected.messages.length, 2);
  const marker = projected.messages[0].content[0].text;
  const payloadHandler = mock.events.get("before_provider_request")?.[0];
  const rewritten = (await payloadHandler?.(
    {
      type: "before_provider_request",
      payload: {
        input: [
          { role: "user", content: [{ type: "input_text", text: marker }] },
          { role: "user", content: [{ type: "input_text", text: "later" }] },
        ],
      },
    },
    replayContext,
  )) as { input: Array<Record<string, unknown>> };
  assert.equal(rewritten.input.at(-2)?.type, "compaction");
  assert.match(JSON.stringify(rewritten.input.at(-1)), /later/);
});

test("overflow hook derives retry proof from the actual retained assistant, and model guards still apply", async () => {
  for (const stopReason of ["error", "length", "stop"] as const) {
    const session = SessionManager.inMemory();
    const keptId = session.appendMessage({ role: "user", content: "request", timestamp: 1 });
    const tail = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "retry response" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason,
      timestamp: 2,
    };
    session.appendMessage(tail);
    const mock = createMockPi();
    createCodexCompactExtension({ settingsRuntime: settingsRuntime(), fetch: async () => sseResponse() })(mock.pi);
    const { ctx } = createMockContext({
      model,
      getSystemPrompt: () => "",
      sessionManager: session,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }),
        getProvider: () => fakeProvider(),
      },
    });
    const result = (await mock.events.get("session_before_compact")?.[0](
      {
        ...event(),
        reason: "overflow",
        willRetry: true,
        branchEntries: session.getBranch(),
        preparation: { ...event().preparation, firstKeptEntryId: keptId },
      },
      ctx,
    )) as { compaction: { summary: string; details: unknown } };
    const details = parseCheckpointDetails(result.compaction.details);
    assert.ok(details);
    assert.deepEqual(details.retryTrimmedTail, stopReason === "stop" ? undefined : tail);
    session.appendCompaction(result.compaction.summary, keptId, 100, details, true);
    await mock.events.get("session_compact")?.[0](
      { willRetry: true, compactionEntry: session.getBranch().at(-1) },
      ctx,
    );
    const runtime = session.buildSessionContext().messages.slice(0, -1);
    const projected = await mock.events.get("context")?.[0]({ messages: runtime }, ctx);
    if (stopReason === "stop") assert.equal(projected, undefined);
    else {
      assert.match(JSON.stringify(projected), /PI_CODEX_REMOTE_CHECKPOINT/);
      const mismatched = createMockContext({ model: { ...model, id: "different" }, sessionManager: session }).ctx;
      assert.equal(await mock.events.get("context")?.[0]({ messages: runtime }, mismatched), undefined);
    }
  }
});

for (const edit of ["omit", "replace"] as const) {
  test(`real Pi ${edit} edit at the cut point fingerprints only projected kept messages and replays after reload`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-codex-compact-projection-"));
    try {
      const session = SessionManager.create(directory, directory);
      session.appendMessage({ role: "user", content: "earlier context ".repeat(30), timestamp: 1 });
      if (edit === "omit") {
        session.appendMessage({ role: "user", content: "recovered input ".repeat(30), timestamp: 2 });
      }
      const privateTail = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "private abandoned attempt" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "error" as const,
        timestamp: 3,
      };
      const cutpointId = session.appendMessage(privateTail);
      session.appendContextEdit(
        cutpointId,
        edit === "omit" ? null : { content: [{ type: "text", text: "public retry tail" }] },
      );
      const branchEntries = session.getBranch();
      const preparation = { ...event().preparation, firstKeptEntryId: cutpointId };
      const projection = buildSessionProjection(branchEntries);
      const keptIndex = projection.entries.findIndex((entry) => entry.sourceEntry.id === cutpointId);
      const visibleKept = projection.entries.slice(keptIndex).flatMap((entry) => entry.messages);
      assert.equal(visibleKept.length, edit === "omit" ? 0 : 1);
      const mock = createMockPi();
      createCodexCompactExtension({ settingsRuntime: settingsRuntime(), fetch: async () => sseResponse() })(mock.pi);
      const { ctx } = createMockContext({
        model,
        getSystemPrompt: () => "",
        sessionManager: session,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }),
          getProvider: () => fakeProvider(),
        },
      });
      const result = (await mock.events.get("session_before_compact")?.[0](
        { ...event(), reason: "overflow", willRetry: true, branchEntries, preparation },
        ctx,
      )) as { compaction: { summary: string; firstKeptEntryId: string; details: unknown } } | undefined;
      assert.ok(result);
      assert.equal(result.compaction.firstKeptEntryId, cutpointId);
      const details = parseCheckpointDetails(result.compaction.details);
      assert.ok(details);
      assert.deepEqual(details.keptMessageFingerprints, visibleKept.map(fingerprintMessage));
      assert.deepEqual(details.retryTrimmedTail, edit === "omit" ? undefined : visibleKept[0]);
      assert.doesNotMatch(JSON.stringify(details), /private abandoned attempt/);

      session.appendCompaction(result.compaction.summary, cutpointId, preparation.tokensBefore, details, true);
      const persisted = session.buildSessionContext().messages;
      if (edit === "omit") {
        const afterCompaction = await mock.events.get("context")?.[0]({ messages: persisted }, ctx);
        assert.ok(afterCompaction, "omitted cut point has no retry proof and replays immediately");
        assert.match(JSON.stringify(afterCompaction), /PI_CODEX_REMOTE_CHECKPOINT/);
      } else {
        assert.deepEqual(persisted.at(-1), visibleKept[0]);
      }
      assert.doesNotMatch(JSON.stringify(persisted), /private abandoned attempt/);
      await mock.events.get("session_compact")?.[0](
        { willRetry: true, compactionEntry: session.getBranch().at(-1) },
        ctx,
      );
      const runtime = edit === "replace" ? persisted.slice(0, -1) : persisted;
      const retried = await mock.events.get("context")?.[0]({ messages: runtime }, ctx);
      assert.ok(retried, "retry context replays when Pi trims the edited error tail");
      await mock.events.get("session_shutdown")?.[0]({ reason: "reload" }, ctx);
      const reloadedMock = createMockPi();
      createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(reloadedMock.pi);
      await reloadedMock.events.get("session_start")?.[0]({ reason: "reload" }, ctx);
      assert.ok(await reloadedMock.events.get("context")?.[0]({ messages: runtime }, ctx));

      const sessionFile = session.getSessionFile();
      assert.ok(sessionFile);
      const reopened = SessionManager.open(sessionFile);
      const reopenedMock = createMockPi();
      createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(reopenedMock.pi);
      const reopenedContext = createMockContext({ model, sessionManager: reopened }).ctx;
      await reopenedMock.events.get("session_start")?.[0]({ reason: "startup" }, reopenedContext);
      const fromDisk = await reopenedMock.events.get("context")?.[0](
        { messages: reopened.buildSessionContext().messages },
        reopenedContext,
      );
      assert.ok(fromDisk, "persisted checkpoint replays after reopening the session file");
      assert.match(JSON.stringify(fromDisk), /PI_CODEX_REMOTE_CHECKPOINT/);
      assert.doesNotMatch(JSON.stringify(fromDisk), /private abandoned attempt/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("real Pi transcript and Codex provider keep current prompt, tools, and replay lineage across compactions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-compact-transcript-"));
  try {
    const session = SessionManager.create(directory, directory);
    const oldTool = { name: "old-tool", description: "Old tool", parameters: Type.Object({}) };
    const newTool = { name: "new-tool", description: "New tool", parameters: Type.Object({}) };
    session.appendMessage({
      role: "system",
      content: "Original instructions",
      sections: { policy: "<policy>old</policy>" },
      toolsAdded: [oldTool],
      timestamp: 1,
    });
    session.appendMessage({ role: "user", content: "Earlier request", timestamp: 2 });
    const keptId = session.appendMessage({ role: "user", content: "Read the file", timestamp: 3 });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Inspecting" },
        { type: "toolCall", id: "call-1", name: "old-tool", arguments: {} },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "toolUse",
      timestamp: 4,
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "old-tool",
      content: [{ type: "text", text: "File contents" }],
      isError: false,
      timestamp: 5,
    });
    session.appendMessage({
      role: "system",
      content: "Updated instructions",
      sections: { policy: "<policy>new</policy>" },
      toolsRemoved: [{ name: oldTool.name }],
      toolsAdded: [newTool],
      timestamp: 6,
    });
    session.appendMessage({ role: "user", content: "Continue with the new tool", timestamp: 7 });

    const actualProvider = openaiCodexProvider();
    const payloads: Array<{ instructions: string; tools: Array<{ name: string }>; input: unknown[] }> = [];
    const provider: Provider = {
      ...actualProvider,
      stream(requestModel, context, options) {
        return actualProvider.stream(requestModel, context, {
          ...options,
          onPayload: async (payload, payloadModel) => {
            const prepared = await options?.onPayload?.(payload, payloadModel);
            payloads.push(structuredClone(prepared ?? payload) as (typeof payloads)[number]);
            return prepared;
          },
        });
      },
    };
    const mock = createMockPi({ activeTools: [newTool.name], allTools: [oldTool, newTool] });
    createCodexCompactExtension({ settingsRuntime: settingsRuntime(), fetch: async () => sseResponse() })(mock.pi);
    const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.x`;
    const { ctx } = createMockContext({
      model,
      getSystemPrompt: () => getCurrentSystemPrompt(buildSessionProjection(session.getBranch()).messages),
      sessionManager: session,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
        getProvider: () => provider,
      },
    });
    const firstBranch = session.getBranch();
    const projected = buildSessionProjection(firstBranch);
    const keptIndex = projected.entries.findIndex((entry) => entry.sourceEntry.id === keptId);
    const retained = projected.entries
      .slice(keptIndex)
      .flatMap((entry) => entry.messages)
      .filter((message) => message.role !== "system");
    const first = (await mock.events.get("session_before_compact")?.[0](
      { ...event(), branchEntries: firstBranch, preparation: { ...event().preparation, firstKeptEntryId: keptId } },
      ctx,
    )) as { compaction: { summary: string; firstKeptEntryId: string; details: unknown } } | undefined;
    assert.ok(first);
    assert.equal(first.compaction.firstKeptEntryId, keptId);
    const firstDetails = parseCheckpointDetails(first.compaction.details);
    assert.ok(firstDetails);
    assert.deepEqual(firstDetails.keptMessageFingerprints, retained.map(fingerprintMessage));
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].instructions.includes("Stale shorthand"), false);
    assert.equal(payloads[0].instructions.match(/Original instructions/g)?.length, 1);
    assert.equal(payloads[0].instructions.match(/Updated instructions/g)?.length, 1);
    assert.match(payloads[0].instructions, /<policy>new<\/policy>/);
    assert.doesNotMatch(payloads[0].instructions, /<policy>old<\/policy>/);
    assert.deepEqual(
      payloads[0].tools.map((tool) => tool.name),
      [newTool.name],
    );
    assert.match(JSON.stringify(payloads[0].input), /Read the file/);
    assert.match(JSON.stringify(payloads[0].input), /Inspecting/);
    assert.match(JSON.stringify(payloads[0].input), /File contents/);
    session.appendCompaction(first.compaction.summary, keptId, 100, firstDetails, true);
    const persisted = session.buildSessionContext().messages;
    assert.deepEqual(persisted.slice(2), retained);
    assert.deepEqual(
      getCurrentSystemMessage(persisted)?.toolsAdded?.map((tool) => tool.name),
      [newTool.name],
    );
    assert.ok(await mock.events.get("context")?.[0]({ messages: persisted }, ctx));

    const laterId = session.appendMessage({ role: "user", content: "One more task", timestamp: 8 });
    const second = (await mock.events.get("session_before_compact")?.[0](
      {
        ...event(),
        branchEntries: session.getBranch(),
        preparation: { ...event().preparation, firstKeptEntryId: laterId },
      },
      ctx,
    )) as { compaction: { summary: string; firstKeptEntryId: string; details: unknown } } | undefined;
    assert.ok(second);
    assert.equal(second.compaction.firstKeptEntryId, laterId);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].instructions.match(/Original instructions/g)?.length, 1);
    assert.equal(payloads[1].instructions.match(/Updated instructions/g)?.length, 1);
    assert.doesNotMatch(payloads[1].instructions, /Stale shorthand/);
    assert.deepEqual(
      payloads[1].tools.map((tool) => tool.name),
      [newTool.name],
    );
    assert.match(JSON.stringify(payloads[1].input), /opaque/);
    const secondDetails = parseCheckpointDetails(second.compaction.details);
    assert.ok(secondDetails);
    session.appendCompaction(second.compaction.summary, laterId, 100, secondDetails, true);
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(sessionFile);
    const reopenedMock = createMockPi();
    createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(reopenedMock.pi);
    const reopenedContext = createMockContext({ model, sessionManager: reopened }).ctx;
    await reopenedMock.events.get("session_start")?.[0]({ reason: "startup" }, reopenedContext);
    const replayed = await reopenedMock.events.get("context")?.[0](
      { messages: reopened.buildSessionContext().messages },
      reopenedContext,
    );
    assert.ok(replayed, "the newest checkpoint must replay from the persisted system snapshot and retained tail");
    assert.match(JSON.stringify(replayed), /PI_CODEX_REMOTE_CHECKPOINT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const change of ["prompt", "tools"] as const) {
  test(`real Pi rejects pending ${change} changes, then compacts their next persisted turn and replays after reload`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-codex-compact-pending-system-"));
    try {
      const session = SessionManager.create(directory, directory);
      const originalTool = {
        name: "inspect",
        description: "Inspect a path",
        parameters: Type.Object({ path: Type.String() }),
        constrainedSampling: true,
      };
      const nextTool = {
        name: "search",
        description: "Search files",
        parameters: Type.Object({ query: Type.String() }),
      };
      session.appendMessage({
        role: "system",
        content: "Original instructions",
        toolsAdded: [originalTool],
        timestamp: 1,
      });
      const originalTurnId = session.appendMessage({ role: "user", content: "Original task", timestamp: 2 });
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Initial answer" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: 3,
      });
      // Pi's live ToolInfo and persisted declaration have distinct TypeBox symbols
      // and object identities even though their model-visible schemas are equal.
      const mock = createMockPi({
        activeTools: [originalTool.name],
        allTools: [{ ...originalTool, parameters: Type.Object({ path: Type.String() }) }, nextTool],
      });
      const payloads: Array<{ instructions: string; tools: Array<{ name: string }>; input: unknown[] }> = [];
      const actualProvider = openaiCodexProvider();
      const provider: Provider = {
        ...actualProvider,
        stream(requestModel, context, options) {
          return actualProvider.stream(requestModel, context, {
            ...options,
            onPayload: async (payload, payloadModel) => {
              const prepared = await options?.onPayload?.(payload, payloadModel);
              payloads.push(structuredClone(prepared ?? payload) as (typeof payloads)[number]);
              return prepared;
            },
          });
        },
      };
      let fetches = 0;
      createCodexCompactExtension({
        settingsRuntime: settingsRuntime(),
        fetch: async () => {
          fetches += 1;
          return sseResponse();
        },
      })(mock.pi);
      const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.x`;
      let livePrompt = "Original instructions";
      const { ctx, notifications } = createMockContext({
        model,
        getSystemPrompt: () => livePrompt,
        sessionManager: session,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
          getProvider: () => provider,
        },
        hasUI: true,
      });
      if (change === "prompt") livePrompt = "Original instructions\n\nNew instructions";
      else mock.pi.setActiveTools([nextTool.name]);
      const handler = mock.events.get("session_before_compact")?.[0];
      const pending = await handler?.(
        {
          ...event(),
          branchEntries: session.getBranch(),
          preparation: { ...event().preparation, firstKeptEntryId: originalTurnId },
        },
        ctx,
      );
      assert.equal(pending, undefined, "an unsent live change must use Pi native compaction");
      assert.equal(fetches, 0);
      assert.equal(payloads.length, 0);
      assert.match(notifications.at(-1)?.message ?? "", /using Pi compaction/);

      session.appendMessage({
        role: "system",
        content: change === "prompt" ? "New instructions" : "",
        ...(change === "tools" ? { toolsRemoved: [{ name: originalTool.name }], toolsAdded: [nextTool] } : {}),
        timestamp: 4,
      });
      const nextTurnId = session.appendMessage({ role: "user", content: "Next task", timestamp: 5 });
      const transcript = buildSessionProjection(session.getBranch()).messages;
      assert.equal(getCurrentSystemPrompt(transcript), livePrompt);
      assert.deepEqual(
        getCurrentTools(transcript).map((tool) => tool.name),
        [change === "tools" ? nextTool.name : originalTool.name],
      );
      const result = (await handler?.(
        {
          ...event(),
          branchEntries: session.getBranch(),
          preparation: { ...event().preparation, firstKeptEntryId: nextTurnId },
        },
        ctx,
      )) as { compaction: { summary: string; details: unknown } } | undefined;
      assert.ok(result, "persisted changes can be sent to Codex");
      assert.equal(fetches, 1);
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].instructions, livePrompt);
      assert.deepEqual(
        payloads[0].tools.map((tool) => tool.name),
        [change === "tools" ? nextTool.name : originalTool.name],
      );
      assert.match(JSON.stringify(payloads[0].input), /Next task/);
      const details = parseCheckpointDetails(result.compaction.details);
      assert.ok(details);
      session.appendCompaction(result.compaction.summary, nextTurnId, 100, details, true);
      assert.equal(getCurrentSystemPrompt(session.buildSessionContext().messages), livePrompt);
      const sessionFile = session.getSessionFile();
      assert.ok(sessionFile);
      const reopened = SessionManager.open(sessionFile);
      assert.deepEqual(
        reopened.getBranch().map((entry) => entry.type),
        session.getBranch().map((entry) => entry.type),
      );
      const reopenedMock = createMockPi();
      createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(reopenedMock.pi);
      const reopenedContext = createMockContext({ model, sessionManager: reopened }).ctx;
      await reopenedMock.events.get("session_start")?.[0]({ reason: "startup" }, reopenedContext);
      const persisted = reopened.buildSessionContext().messages;
      assert.equal(getCurrentSystemPrompt(persisted), livePrompt);
      assert.deepEqual(
        getCurrentTools(persisted).map((tool) => tool.name),
        [change === "tools" ? nextTool.name : originalTool.name],
      );
      const replayed = await reopenedMock.events.get("context")?.[0]({ messages: persisted }, reopenedContext);
      assert.ok(replayed);
      assert.match(JSON.stringify(replayed), /PI_CODEX_REMOTE_CHECKPOINT/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const change of ["prompt", "tools", "context edit"] as const) {
  test(`real Codex response is discarded if live ${change} changes during the request`, async () => {
    const session = SessionManager.inMemory();
    const originalTool = { name: "inspect", description: "Inspect a path", parameters: Type.Object({}) };
    const nextTool = { name: "search", description: "Search files", parameters: Type.Object({}) };
    session.appendMessage({
      role: "system",
      content: "Initial instructions",
      toolsAdded: [originalTool],
      timestamp: 1,
    });
    const keptId = session.appendMessage({ role: "user", content: "Task", timestamp: 2 });
    const mock = createMockPi({ activeTools: [originalTool.name], allTools: [originalTool, nextTool] });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    let fetches = 0;
    createCodexCompactExtension({
      settingsRuntime: settingsRuntime(),
      fetch: async () => {
        fetches += 1;
        dispatched();
        await blocked;
        return sseResponse();
      },
    })(mock.pi);
    const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.x`;
    let livePrompt = "Initial instructions";
    const { ctx, statuses } = createMockContext({
      model,
      getSystemPrompt: () => livePrompt,
      sessionManager: session,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
        getProvider: () => openaiCodexProvider(),
      },
    });
    const inFlight = mock.events.get("session_before_compact")?.[0](
      {
        ...event(),
        branchEntries: session.getBranch(),
        preparation: { ...event().preparation, firstKeptEntryId: keptId },
      },
      ctx,
    );
    await sent;
    if (change === "prompt") livePrompt = "Changed while awaiting Codex";
    else if (change === "tools") mock.pi.setActiveTools([nextTool.name]);
    else session.appendContextEdit(keptId, { content: "Changed after request started" });
    release();
    assert.equal(await inFlight, undefined);
    assert.equal(fetches, 1);
    assert.equal(statuses.get("codex-compact"), undefined);
    assert.equal(
      session.getBranch().some((entry) => entry.type === "compaction"),
      false,
    );
  });
}

test("session lifecycle reloads settings, warns once current, and drops stale reload continuations", async () => {
  const mock = createMockPi();
  let reloads = 0;
  let flushes = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = settingsRuntime();
  const delayed: CodexCompactSettingsRuntime = {
    ...runtime,
    async reload(signal) {
      reloads += 1;
      await blocked;
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return runtime.get();
    },
    async flush() {
      flushes += 1;
    },
  };
  createCodexCompactExtension({ settingsRuntime: delayed })(mock.pi);
  const start = mock.events.get("session_start")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  const { ctx, notifications, statuses } = createMockContext({
    hasUI: true,
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
  });
  const pending = Promise.resolve(start?.({ type: "session_start", reason: "startup" }, ctx));
  await Promise.resolve();
  await shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);
  release();
  await pending;
  assert.equal(reloads, 1);
  assert.equal(flushes, 1);
  assert.equal(notifications.length, 0, "stale startup does not notify through the old session");
  assert.equal(statuses.get("codex-compact"), undefined);
});

test("disabled, unsupported, auth-failed, and aborted compaction paths remain safe", async () => {
  const run = async (options: {
    settings?: CodexCompactSettingsRuntime;
    model?: unknown;
    auth?: unknown;
    signal?: AbortSignal;
  }) => {
    const mock = createMockPi();
    createCodexCompactExtension({
      settingsRuntime: options.settings ?? settingsRuntime(),
      fetch: async () => sseResponse(),
    })(mock.pi);
    const handler = mock.events.get("session_before_compact")?.[0];
    const { ctx, notifications, statuses } = createMockContext({
      model: options.model ?? model,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => "session", getBranch: () => branch() },
      modelRegistry: {
        getApiKeyAndHeaders: async () => options.auth ?? { ok: false, error: "missing auth" },
        getProvider: () => fakeProvider(),
      },
      hasUI: true,
    });
    return {
      result: await handler?.(event(options.signal), ctx),
      notifications,
      statuses,
    };
  };
  assert.equal((await run({ settings: settingsRuntime({ enabled: false }) })).result, undefined);
  assert.equal(
    (
      await run({
        model: { ...model, provider: "openai", api: "openai-responses" },
      })
    ).result,
    undefined,
  );
  const failed = await run({});
  assert.equal(failed.result, undefined);
  assert.match(failed.notifications.at(-1)?.message ?? "", /using Pi compaction/);
  assert.equal(failed.statuses.get("codex-compact"), undefined);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual((await run({ signal: controller.signal })).result, { cancel: true });
});
