import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  SessionManager,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  buildReplacementHistory,
  CHECKPOINT_VERSION,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  LAYERED_CHECKPOINT_VERSION,
  layeredReplacementHistory,
  layeredSummaryItem,
  layeredSummaryText,
  parseCheckpointDetails,
  priorLayeredSummary,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { readLastDiagnostic } from "../src/diagnostics.js";
import { layeredSummaryInput, requestLayeredSummary } from "../src/layered-fallback.js";
import type { JsonObject } from "../src/protocol.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import { createMockContext, createMockPi, stableProvider } from "./support.js";

const model = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<"openai-codex-responses">;

const usage = {
  input: 30,
  output: 7,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 37,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const priorOpaque = { type: "compaction", encrypted_content: "prior-opaque" };
const priorBackup = {
  role: "user",
  content: [{ type: "input_text", text: "old request" }],
};

function settingsRuntime(overrides: Partial<CodexCompactSettingsState["settings"]> = {}): CodexCompactSettingsRuntime {
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/tmp/test-pi-codex-compact.json",
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      allowCanonicalHistory: true,
      maxRetries: 0,
      ...overrides,
    },
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

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

type Summary = { text: string } | { fail: true } | { hang: true } | { aborted: string };

/** Remote V2 goes through `stream` + fetch; Pi's native summary through `streamSimple`. */
function fakeProvider(summary: () => Summary, summaries: Array<{ context: TranscriptContext; options?: unknown }>) {
  return (): Provider => ({
    id: "openai-codex",
    name: "OpenAI Codex",
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(_model, context, options) {
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
          const payload = await options?.onPayload?.({ model: model.id, input, tools: [] }, model);
          const response = await options?.fetch?.("https://example.test", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          await response?.text();
          const message = assistant("");
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        } catch {
          const message = assistant("", "error");
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    streamSimple(_model, context, options) {
      summaries.push({ context, options });
      const stream = createAssistantMessageEventStream();
      const next = summary();
      if ("hang" in next) return stream;
      if ("aborted" in next) {
        // A provider-side abort: Pi's summarizer returns this partial text instead of throwing.
        const message = assistant(next.aborted, "aborted");
        queueMicrotask(() => {
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        });
        return stream;
      }
      const message =
        "fail" in next ? { ...assistant("", "error"), errorMessage: "SUMMARY_SECRET_CANARY" } : assistant(next.text);
      queueMicrotask(() => {
        if ("fail" in next) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
}

function compactionSse(encrypted = "next-opaque") {
  const item = { type: "compaction", encrypted_content: encrypted };
  return new Response(
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const keptMessage = {
  role: "user" as const,
  content: "kept request",
  timestamp: 2,
};
const droppedMessage = {
  role: "user" as const,
  content: "DROPPED_CANARY newer request",
  timestamp: 3,
};
const tailMessage = {
  role: "user" as const,
  content: "TAIL_CANARY latest request",
  timestamp: 4,
};

/** A valid compatible checkpoint, a dropped span after it, and a retained tail. */
function checkpointSession(prior: Partial<CodexCheckpointDetails> = {}) {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
  const keptId = session.appendMessage(keptMessage);
  const details = createCheckpointDetails({
    modelId: model.id,
    checkpointId: "checkpoint-prior",
    replacementHistory: [priorBackup, priorOpaque],
    keptMessages: [keptMessage],
  });
  session.appendCompaction(fallbackSummary(details.checkpointId), keptId, 123, { ...details, ...prior }, true);
  session.appendMessage(droppedMessage);
  const tailId = session.appendMessage(tailMessage);
  return { session, tailId };
}

function compactEvent(
  session: SessionManager,
  firstKeptEntryId: string,
  messagesToSummarize: AgentMessage[],
  signal = new AbortController().signal,
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId,
      messagesToSummarize,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 456,
      previousSummary: fallbackSummary("checkpoint-prior"),
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    },
    branchEntries: session.getBranch(),
    reason: "threshold",
    willRetry: false,
    signal,
  };
}

function harness(
  options: {
    session?: SessionManager;
    settings?: Partial<CodexCompactSettingsState["settings"]>;
    remote?: (payload: JsonObject) => Response | Promise<Response>;
    summary?: () => Summary;
    hasUI?: boolean;
    confirm?: () => Promise<boolean>;
  } = {},
) {
  const session = options.session ?? checkpointSession().session;
  const mock = createMockPi();
  const remotePayloads: JsonObject[] = [];
  const summaries: Array<{ context: TranscriptContext; options?: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as JsonObject;
    remotePayloads.push(payload);
    return options.remote ? options.remote(payload) : new Response('{"error":"overloaded"}', { status: 503 });
  };
  createCodexCompactExtension({
    settingsRuntime: settingsRuntime(options.settings),
    fetch,
  })(mock.pi);
  const { ctx, notifications, statuses } = createMockContext({
    model,
    hasUI: options.hasUI ?? true,
    mode: "tui",
    getSystemPrompt: () => "",
    sessionManager: session,
    ...(options.confirm ? { confirm: options.confirm } : {}),
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "fake-test-key",
        headers: { "X-Test": "header" },
      }),
      getProvider: stableProvider(
        fakeProvider(options.summary ?? (() => ({ text: "LAYERED_SUMMARY_CANARY" })), summaries),
      ),
    },
  });
  const compact = async (event: SessionBeforeCompactEvent) =>
    (await mock.events.get("session_before_compact")?.[0](event, ctx)) as
      | {
          cancel?: true;
          compaction?: {
            summary: string;
            firstKeptEntryId: string;
            tokensBefore: number;
            usage?: unknown;
            details: unknown;
          };
        }
      | undefined;
  return {
    session,
    mock,
    ctx,
    notifications,
    statuses,
    remotePayloads,
    summaries,
    fetch,
    compact,
  };
}

function summaryPrompt(context: TranscriptContext): string {
  const user = context.messages.find((message) => message.role === "user");
  assert.ok(user && Array.isArray(user.content) && user.content[0]?.type === "text");
  return user.content[0].text;
}

test("layered checkpoint format: version 2 keeps the opaque item and replaces, never stacks, its summary", () => {
  const prior = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: [priorBackup, priorOpaque],
    keptMessages: [],
  });
  assert.equal(prior.version, CHECKPOINT_VERSION);
  const first = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: layeredReplacementHistory(prior, "  first summary  "),
    keptMessages: [],
  });
  assert.equal(first.version, LAYERED_CHECKPOINT_VERSION);
  assert.deepEqual(first.replacementHistory, [priorBackup, priorOpaque, layeredSummaryItem("first summary")]);
  assert.equal(priorLayeredSummary(first), "first summary");
  assert.equal(priorLayeredSummary(prior), undefined);
  assert.deepEqual(parseCheckpointDetails(structuredClone(first)), first, "a layered checkpoint survives persistence");

  const second = layeredReplacementHistory(first, "merged summary");
  assert.deepEqual(second, [priorBackup, priorOpaque, layeredSummaryItem("merged summary")]);

  // Version and shape must agree; unknown future versions stay protected as malformed.
  for (const malformed of [
    { ...first, version: CHECKPOINT_VERSION },
    { ...prior, version: LAYERED_CHECKPOINT_VERSION },
    {
      ...first,
      replacementHistory: [priorOpaque, layeredSummaryItem("a"), layeredSummaryItem("b")],
    },
    { ...first, replacementHistory: [layeredSummaryItem("orphan")] },
    { ...first, version: 3 },
  ]) {
    assert.equal(parseCheckpointDetails(malformed), undefined, JSON.stringify(malformed.replacementHistory));
  }
});

test("layered summaries are bounded by the retained-history budget and absorbed by the next opaque fold", () => {
  const prior = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: [priorOpaque],
    keptMessages: [],
  });
  const history = layeredReplacementHistory(prior, `HEAD ${"x".repeat(40_000)}`, { tokenBudget: 8_000 });
  const text = layeredSummaryText(history.at(-1));
  assert.ok(text);
  assert.equal(text.length, 32_000);
  assert.ok(text.startsWith("HEAD "));
  assert.ok(text.endsWith("\n[summary truncated]"));
  assert.throws(() => layeredReplacementHistory(prior, "   "), /empty/);

  // The next remote input carries the summary; the new checkpoint keeps only real user backups.
  const next = buildReplacementHistory(
    [
      priorBackup,
      priorOpaque,
      layeredSummaryItem("absorbed"),
      { role: "user", content: [{ type: "input_text", text: "recent" }] },
    ],
    { type: "compaction", encrypted_content: "next-opaque" },
  );
  assert.deepEqual(next, [
    priorBackup,
    { role: "user", content: [{ type: "input_text", text: "recent" }] },
    { type: "compaction", encrypted_content: "next-opaque" },
  ]);
});

test("remote failure over an active checkpoint publishes a layered checkpoint of only the dropped span", async () => {
  const { session, tailId } = checkpointSession();
  const h = harness({ session });
  const result = await h.compact(compactEvent(session, tailId, [keptMessage, droppedMessage]));
  assert.equal(h.remotePayloads.length, 1, "Remote V2 was attempted first");
  assert.equal(h.summaries.length, 1);
  const { context, options } = h.summaries[0];
  assert.ok(
    summaryPrompt(context).startsWith(
      `<conversation>\n${serializeConversation(convertToLlm([droppedMessage]))}\n</conversation>\n\n`,
    ),
    "only the dropped span the opaque item does not cover, never the placeholder summary",
  );
  const summaryOptions = options as SimpleStreamOptions;
  assert.equal(summaryOptions.apiKey, "fake-test-key");
  assert.deepEqual(summaryOptions.headers, { "X-Test": "header" });
  assert.equal(typeof summaryOptions.fetch, "function");
  assert.notEqual(summaryOptions.fetch, h.fetch, "physical attempts must pass through the live-state fence");
  assert.equal(summaryOptions.transport, "sse");
  assert.equal(summaryOptions.maxRetries, 0);
  assert.equal(summaryOptions.cacheRetention, "none");

  assert.ok(result?.compaction);
  const details = parseCheckpointDetails(result.compaction.details);
  assert.ok(details);
  assert.equal(details.version, LAYERED_CHECKPOINT_VERSION);
  assert.notEqual(details.checkpointId, "checkpoint-prior");
  assert.deepEqual(details.replacementHistory, [
    priorBackup,
    priorOpaque,
    layeredSummaryItem("LAYERED_SUMMARY_CANARY"),
  ]);
  assert.deepEqual(
    details.keptMessageFingerprints,
    createCheckpointDetails({
      modelId: model.id,
      replacementHistory: [priorOpaque],
      keptMessages: [tailMessage],
    }).keptMessageFingerprints,
  );
  assert.equal(result.compaction.summary, fallbackSummary(details.checkpointId));
  assert.equal(result.compaction.firstKeptEntryId, tailId);
  assert.equal(result.compaction.tokensBefore, 456);
  assert.deepEqual(result.compaction.usage, usage);

  assert.equal(h.notifications.length, 1);
  assert.match(
    h.notifications[0].message,
    /^Codex remote compaction failed; kept the opaque checkpoint and added Pi's readable summary of newer history \(layered fallback\)\. \[remote_http_error; HTTP 503\] Last stage: layered_summary; /,
  );
  assert.equal(h.statuses.get("codex-compact"), undefined);
  const row = (await readLastDiagnostic(session.getSessionId())).at(-1);
  assert.equal(row?.outcome, "layered");
  assert.equal(row?.error, "remote_http_error");
  assert.equal(row?.lastPhase, "layered_summary");
  assert.equal(row?.completed, 0, "the summary is not counted as a completed fold");
  assert.equal(row?.totalTokens, usage.totalTokens);

  // Replay: the marker expands to the old opaque history followed by the summary, then the kept tail.
  session.appendCompaction(result.compaction.summary, tailId, 456, details, true);
  const projected = (await h.mock.events.get("context")?.[0](
    { messages: session.buildSessionContext().messages },
    h.ctx,
  )) as { messages: AgentMessage[] } | undefined;
  assert.ok(projected);
  assert.deepEqual(
    projected.messages.map((message) => (message.role === "user" ? message.content : message.role)),
    [[{ type: "text", text: checkpointMarker(details.checkpointId) }], tailMessage.content],
  );
  const tailItem = {
    role: "user",
    content: [{ type: "input_text", text: tailMessage.content }],
  };
  const payload = {
    model: model.id,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: checkpointMarker(details.checkpointId) }],
      },
      tailItem,
    ],
  };
  assert.deepEqual(await h.mock.events.get("before_provider_request")?.[0]({ payload }, h.ctx), {
    ...payload,
    input: [priorBackup, priorOpaque, layeredSummaryItem("LAYERED_SUMMARY_CANARY"), tailItem],
  });

  // Resume: a fresh extension instance restores the same layered replay from session state.
  const resumed = harness({ session });
  await resumed.mock.events.get("session_start")?.[0]({ type: "session_start", reason: "resume" }, resumed.ctx);
  assert.deepEqual(await resumed.mock.events.get("before_provider_request")?.[0]({ payload }, resumed.ctx), {
    ...payload,
    input: [priorBackup, priorOpaque, layeredSummaryItem("LAYERED_SUMMARY_CANARY"), tailItem],
  });
});

test("compaction from a layered checkpoint carries it remotely, or merges its summary on another failure", async () => {
  const layered = createCheckpointDetails({
    modelId: model.id,
    checkpointId: "checkpoint-prior",
    replacementHistory: [priorBackup, priorOpaque, layeredSummaryItem("EARLIER_SUMMARY_CANARY")],
    keptMessages: [keptMessage],
  });
  for (const remoteSucceeds of [true, false]) {
    const { session, tailId } = checkpointSession(layered);
    const h = harness({
      session,
      remote: remoteSucceeds ? () => compactionSse() : undefined,
      summary: () => ({ text: "MERGED_SUMMARY_CANARY" }),
    });
    const result = await h.compact(compactEvent(session, tailId, [keptMessage, droppedMessage]));
    const details = parseCheckpointDetails(result?.compaction?.details);
    assert.ok(details);
    const input = h.remotePayloads[0]?.input;
    assert.ok(Array.isArray(input));
    const item = (message: { content: string }) => ({
      role: "user",
      content: [{ type: "input_text", text: message.content }],
    });
    assert.deepEqual(
      input,
      [
        priorBackup,
        priorOpaque,
        layeredSummaryItem("EARLIER_SUMMARY_CANARY"),
        item(keptMessage),
        item(droppedMessage),
        item(tailMessage),
        { type: "compaction_trigger" },
      ],
      "the next remote request carries the layered history and its verbatim kept lineage",
    );
    if (remoteSucceeds) {
      assert.equal(h.summaries.length, 0);
      assert.equal(details.version, CHECKPOINT_VERSION);
      assert.deepEqual(
        details.replacementHistory,
        [
          priorBackup,
          item(keptMessage),
          item(droppedMessage),
          item(tailMessage),
          { type: "compaction", encrypted_content: "next-opaque" },
        ],
        "the new opaque item absorbed the summary; only user backups remain beside it",
      );
    } else {
      assert.equal(h.summaries.length, 1);
      assert.ok(
        summaryPrompt(h.summaries[0].context).startsWith(
          `<conversation>\n${serializeConversation(convertToLlm([keptMessage, droppedMessage]))}\n</conversation>\n\n<previous-summary>\nEARLIER_SUMMARY_CANARY\n</previous-summary>`,
        ),
        "a layered prior's verbatim kept lineage is summarized and its summary is updated",
      );
      assert.equal(details.version, LAYERED_CHECKPOINT_VERSION);
      assert.deepEqual(details.replacementHistory, [
        priorBackup,
        priorOpaque,
        layeredSummaryItem("MERGED_SUMMARY_CANARY"),
      ]);
    }
  }
});

for (const [name, summary, notice] of [
  ["fails", () => ({ fail: true }) as const, "The layered summary fallback also failed."],
  ["returns empty text", () => ({ text: "   " }), "The layered summary fallback also failed."],
  [
    "is aborted by the provider with partial text",
    () => ({ aborted: "PARTIAL_SUMMARY" }),
    "The layered summary fallback also failed.",
  ],
  ["outlasts its stage budget", () => ({ hang: true }) as const, "The layered summary fallback timed out."],
] as const) {
  test(`native layered summary that ${name} cancels and preserves the checkpoint`, async () => {
    const { session, tailId } = checkpointSession();
    const before = session.getBranch();
    const h = harness({ session, summary, settings: { stageTimeoutMs: 200 } });
    const result = await h.compact(compactEvent(session, tailId, [keptMessage, droppedMessage]));
    assert.deepEqual(result, { cancel: true });
    assert.equal(h.summaries.length, 1);
    assert.deepEqual(session.getBranch(), before);
    assert.equal(h.notifications.length, 1);
    assert.ok(
      h.notifications[0].message.startsWith(
        `Compaction cancelled to preserve the existing opaque checkpoint. [remote_http_error; HTTP 503] ${notice} Last stage: layered_summary;`,
      ),
      h.notifications[0].message,
    );
    assert.doesNotMatch(h.notifications[0].message, /SUMMARY_SECRET_CANARY/);
    const row = (await readLastDiagnostic(session.getSessionId())).at(-1);
    assert.equal(row?.outcome, "failure");
    assert.equal(row?.error, "remote_http_error");
    assert.equal(row?.lastPhase, "layered_summary");
    assert.equal(h.statuses.get("codex-compact"), undefined);
  });
}

for (const drift of ["tools", "prompt"] as const) {
  test(`equal-prompt layered summary rejects ${drift} drift while pending and retains the opaque checkpoint`, async () => {
    const { session, tailId } = checkpointSession();
    const before = structuredClone(session.getBranch());
    const h = harness({
      session,
      summary: () => {
        // Run after streamSimple has returned, before the provider completes.
        queueMicrotask(() => {
          if (drift === "tools") {
            h.mock.rawPi.getAllTools = () => [
              { name: "late-tool", description: "Unsent tool", parameters: { type: "object", properties: {} } },
            ];
            h.mock.rawPi.setActiveTools(["late-tool"]);
          } else {
            (h.ctx as ExtensionContext).getSystemPrompt = () => "Unsent prompt";
          }
        });
        return { text: "STALE_SUMMARY_CANARY" };
      },
    });
    assert.equal((h.ctx as ExtensionContext).getSystemPrompt(), "", "canonical and effective prompts start equal");
    assert.deepEqual(await h.compact(compactEvent(session, tailId, [keptMessage, droppedMessage])), { cancel: true });
    assert.equal(h.summaries.length, 1);
    assert.deepEqual(session.getBranch(), before);
    assert.match(h.notifications.at(-1)?.message ?? "", /cancelled to preserve the existing opaque checkpoint/);
    assert.doesNotMatch(JSON.stringify(h.notifications), /STALE_SUMMARY_CANARY/);
  });
}

test("canonical layered input preserves genuine marker-shaped user content and skips only covered lineage/summaries", () => {
  const { session, tailId } = checkpointSession();
  const prior = parseCheckpointDetails(session.getBranch().find((entry) => entry.type === "compaction")?.details);
  assert.ok(prior);
  const markerString = { ...droppedMessage, content: "[PI_CODEX_REMOTE_CHECKPOINT:real-user-request] explain this" };
  const markerBlock = {
    ...tailMessage,
    content: [{ type: "text" as const, text: "[PI_CODEX_REMOTE_CHECKPOINT:another-real-request] investigate" }],
  };
  const event = compactEvent(session, tailId, [
    { role: "compactionSummary", summary: "already represented", tokensBefore: 123, timestamp: 1 },
    keptMessage,
    markerString,
  ]);
  event.preparation.isSplitTurn = true;
  event.preparation.turnPrefixMessages = [markerBlock];
  assert.deepEqual(layeredSummaryInput(event.preparation, prior), [markerString, markerBlock]);
  const layered = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: layeredReplacementHistory(prior, "previous layer"),
    keptMessages: [keptMessage],
  });
  assert.deepEqual(layeredSummaryInput(event.preparation, layered), [keptMessage, markerString, markerBlock]);
});

for (const transport of ["supplied", "global"] as const) {
  for (const driftAt of ["before-stream", "first-fetch", "retry-fetch"] as const) {
    test(`layered summary fences ${transport} transport at ${driftAt} and sanitizes state errors`, async () => {
      let current = driftAt !== "before-stream";
      let physicalAttempts = 0;
      let streams = 0;
      let providerSignal: AbortSignal | undefined;
      const fetch: typeof globalThis.fetch = async () => {
        physicalAttempts++;
        current = false;
        return new Response("retry", { status: 503 });
      };
      if (transport === "global") vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
      const provider = fakeProvider(() => ({ text: "unused" }), [])();
      provider.streamSimple = (_model, _context, options) => {
        streams++;
        providerSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        if (driftAt === "first-fetch") current = false;
        void (async () => {
          try {
            assert.ok(options?.fetch);
            // A provider retry reuses the same stream invocation.
            await options.fetch("https://offline.test");
            await options.fetch("https://offline.test");
            const message = assistant("must not publish");
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
          } catch {
            const message = { ...assistant("", "error"), errorMessage: "STATE_SECRET_CANARY" };
            stream.push({ type: "error", reason: "error", error: message });
            stream.end(message);
          }
        })();
        return stream;
      };
      const result = await requestLayeredSummary({
        provider,
        model,
        messages: [droppedMessage],
        apiKey: "offline",
        signal: new AbortController().signal,
        isCurrent: () => {
          if (!current) throw new Error("STATE_SECRET_CANARY");
          return true;
        },
        timeoutMs: 10_000,
        maxRetries: 1,
        ...(transport === "supplied" ? { fetch } : {}),
      });
      assert.deepEqual(result, { ok: false, reason: "failed" });
      assert.equal(streams, driftAt === "before-stream" ? 0 : 1);
      assert.equal(physicalAttempts, driftAt === "retry-fetch" ? 1 : 0);
      if (providerSignal) assert.equal(providerSignal.aborted, true);
    });
  }
}

test("layeredFallback: false restores strict cancel-only behavior", async () => {
  const { session, tailId } = checkpointSession();
  const h = harness({ session, settings: { layeredFallback: false } });
  const result = await h.compact(compactEvent(session, tailId, [keptMessage, droppedMessage]));
  assert.deepEqual(result, { cancel: true });
  assert.equal(h.remotePayloads.length, 1);
  assert.equal(h.summaries.length, 0);
  assert.ok(
    h.notifications[0]?.message.startsWith(
      "Compaction cancelled to preserve the existing opaque checkpoint. [remote_http_error; HTTP 503] Layered fallback is off. Last stage:",
    ),
  );
});

test("caller abort during the layered summary cancels silently", async () => {
  const { session, tailId } = checkpointSession();
  const controller = new AbortController();
  const h = harness({
    session,
    summary: () => {
      queueMicrotask(() => controller.abort());
      return { hang: true };
    },
  });
  const result = await h.compact(compactEvent(session, tailId, [keptMessage, droppedMessage], controller.signal));
  assert.deepEqual(result, { cancel: true });
  assert.equal(h.summaries.length, 1);
  assert.deepEqual(h.notifications, []);
});

for (const scenario of ["malformed", "incompatible", "unconsented", "branch-changed", "nothing-dropped"] as const) {
  test(`layered fallback never replaces cancellation: ${scenario}`, async () => {
    const { session, tailId } =
      scenario === "malformed"
        ? checkpointSession({ replacementHistory: [] })
        : scenario === "incompatible"
          ? checkpointSession({ modelId: "other-model" })
          : checkpointSession();
    const before = session.getBranch();
    const h = harness({
      session,
      ...(scenario === "unconsented"
        ? {
            settings: { allowCanonicalHistory: false },
            confirm: async () => false,
          }
        : {}),
      remote:
        scenario === "branch-changed"
          ? () => {
              session.appendMessage({
                role: "user",
                content: "arrived during compaction",
                timestamp: 5,
              });
              return new Response("{}", { status: 503 });
            }
          : undefined,
    });
    const result = await h.compact(
      // The remote checkpoint's opaque item already covers its own kept message.
      compactEvent(session, tailId, scenario === "nothing-dropped" ? [keptMessage] : [keptMessage, droppedMessage]),
    );
    assert.deepEqual(result, { cancel: true });
    assert.equal(h.summaries.length, 0, "no native summary request");
    assert.equal(h.remotePayloads.length, scenario === "branch-changed" || scenario === "nothing-dropped" ? 1 : 0);
    if (scenario !== "branch-changed") assert.deepEqual(session.getBranch(), before);
    assert.match(
      h.notifications.at(-1)?.message ?? "",
      {
        malformed: /\[checkpoint_malformed\]/,
        incompatible: /\[checkpoint_incompatible\]/,
        unconsented: /\[canonical_consent_denied\]/,
        "branch-changed": /\[preparation_branch_changed\]/,
        "nothing-dropped":
          /^Compaction cancelled to preserve the existing opaque checkpoint\. \[remote_http_error; HTTP 503\] Last stage: [a-z_]+;/,
      }[scenario],
    );
  });
}
