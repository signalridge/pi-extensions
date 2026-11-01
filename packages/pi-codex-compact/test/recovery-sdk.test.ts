import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  getCurrentSystemMessage,
  InMemoryCredentialStore,
  type Model,
  normalizeContext,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getLastAssistantUsage,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  checkpointMarker,
  createCheckpointDetails,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { type JsonObject, rewriteCheckpointMarker } from "../src/protocol.js";
import { exportRecoverySession } from "../src/recovery-export.js";
import { resetHistoricalUsage, splitRecoveryContext } from "../src/recovery-snapshot.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline recovery",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://offline-model.test",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64")}.x`;
function sse(compact: boolean): Response {
  const item = compact
    ? { type: "compaction", encrypted_content: "accepted-opaque" }
    : { type: "message", id: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
  const events = compact
    ? [{ type: "response.output_item.done", output_index: 0, item }]
    : [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done." },
        { type: "response.output_item.done", output_index: 0, item },
      ];
  return new Response(
    [
      ...events,
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [item],
          usage: { input_tokens: 17, output_tokens: 4, total_tokens: 21 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function canonical(manager: SessionManager) {
  const transcript = manager.buildSessionContext().messages;
  const details = parseCheckpointDetails(
    manager
      .getBranch()
      .filter((entry) => entry.type === "compaction")
      .at(-1)?.details,
  );
  assert.ok(details);
  const projected = projectCheckpointContext(transcript, details, "full");
  assert.ok(projected);
  const head = getCurrentSystemMessage(transcript);
  assert.ok(head);
  return [head, ...projected.filter((message) => message.role !== "system")];
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-sdk-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live fetch"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("Unexpected live WebSocket");
  });
  const requests: Array<{ payload: JsonObject; url: string }> = [];
  let oversized = false;
  let confirm = async () => true;
  let onFetch = () => {};
  let authHook = async () => {};
  let requestTimeoutMs = DEFAULT_CODEX_COMPACT_SETTINGS.requestTimeoutMs;
  let allowCanonicalHistory = true;
  let layeredFallback = true;
  let mutateRecoveryWire = false;
  let authCount = 0;
  let confirmations = 0;
  let progress: { dispose(): void } | undefined;
  let terminalInput: ((data: string) => unknown) | undefined;
  const widgets = new Map<string, { dispose(): void }>();
  let hold: ((signal?: AbortSignal | null) => Promise<Response>) | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const payload = JSON.parse(
      typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8"),
    ) as JsonObject;
    requests.push({ payload, url: String(url) });
    onFetch();
    if (hold) return hold(init?.signal);
    const compact = payload.input.some((item: JsonObject) => item.type === "compaction_trigger");
    if (compact && oversized)
      return new Response(
        `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "context_window_exceeded" } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return sse(compact);
  };
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const actual = openaiCodexProvider();
  const streamOptions: Array<{ maxRetries?: number; transport?: string }> = [];
  const provider: Provider = {
    ...actual,
    getModels: () => [model, { ...model, id: "default-B" }],
    auth: {
      apiKey: {
        name: "Offline",
        resolve: async () => {
          authCount++;
          await authHook();
          return { auth: { apiKey, baseUrl: "https://resolved-offline.test/backend-api/codex" } };
        },
      },
    },
    stream: (m, c, o) => {
      streamOptions.push({ maxRetries: o?.maxRetries, transport: o?.transport });
      return actual.stream(m, c, {
        ...o,
        transport: "sse",
        fetch: o?.fetch ?? fetch,
        onPayload: async (payload, target) => {
          if (mutateRecoveryWire) {
            const wire = payload as JsonObject;
            assert.ok(wire.tools?.length);
            wire.tools[0].description += " wire-only mutation";
          }
          return o?.onPayload?.(payload, target);
        },
      });
    },
    streamSimple: (m, c, o) => actual.streamSimple(m, c, { ...o, transport: "sse", fetch: o?.fetch ?? fetch }),
  };
  runtime.registerNativeProvider(provider);
  const extensionSettings: CodexCompactSettingsRuntime = {
    get: () => ({
      kind: "missing",
      path: join(directory, "extension-settings.json"),
      document: {},
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, allowCanonicalHistory, requestTimeoutMs, layeredFallback },
    }),
    reload: async () => extensionSettings.get(),
    update: async () => {
      throw new Error("Recovery must not write settings");
    },
    flush: async () => {},
  };
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: model.provider,
    defaultModel: "default-B",
    defaultTools: ["read"],
    compaction: { enabled: false, keepRecentTokens: 6 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const source = SessionManager.create(directory, directory);
  const sessions: AgentSession[] = [];
  initTheme("dark");
  const mock = createMockContext({
    mode: "tui",
    confirm: () => {
      confirmations++;
      return confirm();
    },
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory);
      try {
        if (harness.isPiTuiKitScreen) {
          harness.handleInput("tui.select.down");
          harness.handleInput("tui.select.confirm");
        } else throw new Error("Recovery progress must never own a custom modal");
        return await harness.resultPromise;
      } finally {
        harness.dispose();
      }
    },
  });
  Object.assign((mock.ctx as ExtensionContext).ui, {
    onTerminalInput(handler: (data: string) => unknown) {
      terminalInput = handler;
      return () => {
        if (terminalInput === handler) terminalInput = undefined;
      };
    },
    setWidget(key: string, factory: (() => { dispose(): void }) | undefined) {
      widgets.get(key)?.dispose();
      widgets.delete(key);
      if (factory) {
        progress = factory();
        widgets.set(key, progress);
      }
    },
  });
  const open = async (manager: SessionManager, explicitModel = true) => {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: "Synthetic recovery envelope",
      extensionFactories: [createCodexCompactExtension({ settingsRuntime: extensionSettings, fetch })],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      ...(explicitModel ? { model } : {}),
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
    });
    await session.bindExtensions({ mode: "tui", uiContext: (mock.ctx as ExtensionContext).ui });
    sessions.push(session);
    return session;
  };
  const session = await open(source);
  await session.prompt(`Initial old prefix ${"older content ".repeat(1000)}`);
  await session.prompt("Initial recent turn");
  await session.compact();
  settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 2000 } });
  source.appendCustomEntry("synthetic-control-must-not-copy", { armed: true });
  source.appendMessage({
    role: "user",
    content: `Meaningful new prefix ${"prefix content ".repeat(2000)}`,
    timestamp: 10,
  });
  source.appendMessage({
    role: "user",
    content: [
      { type: "text", text: `TAIL_USER_CANARY ${"tail ".repeat(2000)}` },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    timestamp: 11,
  });
  const usage = {
    input: 900000,
    output: 4,
    cacheRead: 100,
    cacheWrite: 10,
    totalTokens: 900114,
    cost: { input: 9, output: 1, cacheRead: 1, cacheWrite: 1, total: 12 },
  };
  source.appendMessage({
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "TAIL_THINK_CANARY",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_tail",
          encrypted_content: "TAIL_SIGNATURE_CANARY",
          summary: [{ type: "summary_text", text: "TAIL_THINK_CANARY" }],
        }),
      },
      { type: "toolCall", id: "call_tail|fc_tail", name: "read", arguments: { path: "TAIL_ARGUMENT_CANARY" } },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: 12,
    usage,
  });
  source.appendMessage({
    role: "toolResult",
    toolCallId: "call_tail|fc_tail",
    toolName: "read",
    content: [{ type: "text", text: "TAIL_RESULT_CANARY" }],
    timestamp: 13,
    isError: false,
    usage,
  });
  source.appendCustomMessageEntry("synthetic-content", "TAIL_CUSTOM_CANARY", false);
  await session.prompt("Establish unchanged loadout evidence");
  const rawPrompt = session.prompt.bind(session);
  const offer = () => rawPrompt("/codex-compact");
  const confirmationCommand = () => {
    const notice = mock.notifications.findLast((notice) => /Recovery OFFER ONLY/.test(notice.message));
    const nonce = notice?.message.match(/confirm-recovery ([a-f0-9-]{36})/)?.[1];
    assert.ok(nonce, "an informed offer must precede deliberate confirmation");
    return `/codex-compact confirm-recovery ${nonce}`;
  };
  // Legacy scenarios below explicitly perform BOTH SDK-routed commands. The
  // raw offer/confirmation routes remain exposed for ticket lifecycle tests.
  session.prompt = async (text, options) => {
    if (text !== "/codex-compact") return rawPrompt(text, options);
    const start = mock.notifications.length;
    await offer();
    const notice = mock.notifications[start];
    if (!notice?.message.includes("Recovery OFFER ONLY")) return;
    const command = confirmationCommand();
    mock.notifications.splice(start, 1); // Active-work assertions exclude the offer notice.
    if (await confirm()) await rawPrompt(command);
  };
  return {
    offer,
    rawPrompt,
    confirmationCommand,
    denyPersistentCanonical: () => {
      allowCanonicalHistory = false;
    },
    strictCancellation: () => {
      layeredFallback = false;
    },
    mutateRecoveryWire: () => {
      mutateRecoveryWire = true;
    },
    directory,
    session,
    source,
    settingsManager,
    extensionSettings,
    requests,
    open,
    oversized: (value: boolean) => {
      oversized = value;
    },
    confirm: (fn: typeof confirm) => {
      confirm = fn;
    },
    onFetch: (fn: typeof onFetch) => {
      onFetch = fn;
    },
    authHook: (fn: typeof authHook) => {
      authHook = fn;
    },
    hold: (fn: typeof hold) => {
      hold = fn;
    },
    timeout: (milliseconds: number) => {
      requestTimeoutMs = milliseconds;
    },
    authCount: () => authCount,
    confirmations: () => confirmations,
    cancelProgress: () => {
      assert.ok(progress);
      assert.ok(terminalInput);
      terminalInput("\u001b");
    },
    disposeProgress: () => {
      assert.ok(progress);
      progress.dispose();
    },
    input: (data: string) => terminalInput?.(data),
    runtime,
    provider,
    widgets,
    credentials,
    ui: (mock.ctx as ExtensionContext).ui,
    streamOptions,
    notifications: mock.notifications,
    cleanup: () => {
      for (const item of sessions) item.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("SDK TUI offer is read-only and deliberate nonce grants canonical history once even when persistent consent is false", async () => {
  const f = await fixture();
  try {
    f.denyPersistentCanonical();
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const sourceHash = hash(sourceFile);
    const files = readdirSync(f.directory);
    const settings = JSON.stringify(f.extensionSettings.get());
    const requests = f.requests.length;
    const auth = f.authCount();
    vi.spyOn(f.ui, "confirm").mockRejectedValue(new Error("Recovery must never open a native confirm"));
    await f.offer(); // Actual session.prompt command routing under a TUI binding.
    assert.equal(f.requests.length, requests);
    assert.equal(f.authCount(), auth);
    assert.deepEqual(readdirSync(f.directory), files);
    assert.equal(hash(sourceFile), sourceHash);
    assert.equal(f.widgets.size, 0, "an offer owns no progress or modal");
    const notice = f.notifications.at(-1)?.message ?? "";
    for (const informed of [
      /prefix messages/,
      /suffix messages UNSENT/,
      /request-local filters/,
      /cost money/,
      /NEW session/,
      /usage and cost are reset to zero/,
      /Settings do not change/,
    ])
      assert.match(notice, informed);
    const command = f.confirmationCommand();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.authHook(async () => {
      started.resolve();
      await release.promise;
    });
    const accepted = f.rawPrompt(command);
    await started.promise;
    await f.rawPrompt(command); // Duplicate while the first awaits auth.
    assert.equal(f.authCount(), auth + 1);
    assert.equal(f.requests.length, requests);
    assert.match(f.notifications.at(-1)?.message ?? "", /no request was sent/);
    release.resolve();
    await accepted;
    await f.rawPrompt(command); // Duplicate after publication.
    assert.equal(f.requests.length, requests + 1, "one prefix, zero inference or follow-up");
    assert.equal(
      f.requests.at(-1)?.payload.input.filter((item: JsonObject) => item.type === "compaction_trigger").length,
      1,
    );
    assert.equal(f.authCount(), auth + 1);
    assert.equal(hash(sourceFile), sourceHash);
    assert.equal(JSON.stringify(f.extensionSettings.get()), settings);
    assert.equal(readdirSync(f.directory).filter((name) => !files.includes(name) && name.endsWith(".jsonl")).length, 1);
  } finally {
    f.cleanup();
  }
});

for (const action of ["not-confirmed", "expired", "cancel", "malformed", "unknown"] as const) {
  test(`SDK pending nonce ${action} never authenticates, sends, exports or mutates source`, async () => {
    const f = await fixture();
    try {
      const path = f.source.getSessionFile();
      assert.ok(path);
      const before = hash(path);
      const files = readdirSync(f.directory);
      const requests = f.requests.length;
      const auth = f.authCount();
      await f.offer();
      const command = f.confirmationCommand();
      const notices = f.notifications.length;
      if (action === "expired" || action === "not-confirmed") {
        vi.useFakeTimers();
        // Creation used real timers; moving the clock independently also checks
        // handler-side expiry even when the expiry callback has not fired.
        vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
        if (action === "expired") await f.rawPrompt(command);
        else assert.equal(f.notifications.length, notices, "declining by inaction has no stale UI");
      }
      if (action === "cancel") {
        await f.rawPrompt("/codex-compact cancel-recovery");
        await f.rawPrompt(command);
      }
      if (action === "malformed") await f.rawPrompt(`${command} extra`);
      if (action === "unknown")
        await f.rawPrompt("/codex-compact confirm-recovery 00000000-0000-0000-0000-000000000000");
      assert.equal(f.requests.length, requests);
      assert.equal(f.authCount(), auth);
      assert.equal(hash(path), before);
      assert.deepEqual(readdirSync(f.directory), files);
      if (action !== "not-confirmed") assert.match(f.notifications.at(-1)?.message ?? "", /no request was sent/);
    } finally {
      vi.useRealTimers();
      f.cleanup();
    }
  });
}

test("SDK ordinary input discards a pending offer while registered nonce commands bypass input cancellation", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    await f.offer();
    const command = f.confirmationCommand();
    await f.rawPrompt("Deliberately decline recovery by starting an ordinary turn");
    assert.equal(f.requests.length, requests + 1);
    assert.equal(
      f.requests.at(-1)?.payload.input.some((item: JsonObject) => item.type === "compaction_trigger"),
      false,
    );
    const auth = f.authCount();
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const afterUserTurn = hash(sourceFile);
    await f.rawPrompt(command);
    assert.equal(f.requests.length, requests + 1, "stale nonce cannot start recovery or another ordinary turn");
    assert.equal(f.authCount(), auth);
    assert.equal(hash(sourceFile), afterUserTurn);
    assert.match(f.notifications.at(-1)?.message ?? "", /no request was sent/);
  } finally {
    f.cleanup();
  }
});

for (const stopReason of ["error", "aborted"] as const) {
  for (const half of ["prefix", "suffix"] as const) {
    test(`SDK raw closed ${stopReason} call/result in ${half} rejects before recovery credentials`, async () => {
      const f = await fixture();
      try {
        f.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
        f.source.appendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "failed|fc_failed", name: "read", arguments: { path: "synthetic" } }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason,
          timestamp: 20,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        f.source.appendMessage({
          role: "toolResult",
          toolCallId: "failed|fc_failed",
          toolName: "read",
          content: [{ type: "text", text: "Synthetic result ".repeat(half === "suffix" ? 2000 : 1) }],
          isError: false,
          timestamp: 21,
        });
        if (half === "prefix") f.source.appendMessage({ role: "user", content: "Unsent final suffix", timestamp: 22 });
        const sourceFile = f.source.getSessionFile();
        assert.ok(sourceFile);
        const before = hash(sourceFile);
        const files = readdirSync(f.directory);
        const auth = f.authCount();
        const requests = f.requests.length;
        await f.offer();
        assert.equal(f.authCount(), auth);
        assert.equal(f.requests.length, requests);
        assert.deepEqual(readdirSync(f.directory), files);
        assert.equal(hash(sourceFile), before);
        assert.match(f.notifications.at(-1)?.message ?? "", /unavailable.*checkpoint_projection_failed/);
      } finally {
        f.cleanup();
      }
    });
  }
}

test("SDK recovery rejects wire-only declaration mutation using the frozen ordinary-request validator", async () => {
  const f = await fixture();
  try {
    const files = readdirSync(f.directory);
    const requests = f.requests.length;
    await f.offer();
    f.mutateRecoveryWire();
    await f.rawPrompt(f.confirmationCommand());
    assert.equal(f.requests.length, requests, "provider payload drift never reaches fetch");
    assert.deepEqual(readdirSync(f.directory), files);
    assert.match(JSON.stringify(f.notifications), /loadout_mismatch|payload_rejected/);
  } finally {
    f.cleanup();
  }
});

test("actual SDK full oversized → explicit prefix accepted → fresh reopen/fork/exact wire → later full compaction", async () => {
  const f = await fixture();
  try {
    // Recovery export is the explicit path once strict full compaction cancels.
    f.strictCancellation();
    f.oversized(true);
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const sourceHash = hash(sourceFile);
    const backup = join(f.directory, "synthetic-backup.txt");
    copyFileSync(sourceFile, backup);
    const settings = JSON.stringify(f.settingsManager.getSettings());
    const extensionSettings = JSON.stringify(f.extensionSettings.get());
    const creds = await f.credentials.list();
    const requests = f.requests.length;
    await assert.rejects(f.session.compact(), /cancel/i);
    const foldAttempts = f.requests.length - requests;
    assert.ok(foldAttempts > 1 && foldAttempts <= 8, JSON.stringify(f.notifications));
    assert.match(JSON.stringify(f.notifications), /remote_context_window_exceeded/);
    assert.equal(hash(sourceFile), sourceHash);
    const projected = canonical(f.source);
    const prior = parseCheckpointDetails(
      f.source
        .getBranch()
        .filter((entry) => entry.type === "compaction")
        .at(-1)?.details,
    );
    assert.ok(prior);
    const split = splitRecoveryContext(projected.slice(1), prior.checkpointId, 2000);
    assert.ok(split.prefix.length > 1 && split.suffix.length > 1);
    const beforeFiles = new Set(readdirSync(f.directory));
    f.oversized(false);
    await f.session.prompt("/codex-compact");
    const recovery = f.requests.at(-1)?.payload;
    assert.ok(recovery);
    assert.equal(
      f.requests.length,
      requests + foldAttempts + 1,
      "one prefix request only; no automatic ordinary follow-up",
    );
    assert.deepEqual(f.streamOptions.at(-1), { maxRetries: 0, transport: "sse" });
    assert.doesNotMatch(JSON.stringify(recovery), /TAIL_.*CANARY/);
    assert.match(JSON.stringify(recovery), /Meaningful new prefix/);
    assert.deepEqual(recovery.tools, f.requests.at(-2)?.payload.tools);
    assert.deepEqual(recovery.instructions, f.requests.at(-2)?.payload.instructions);
    assert.equal(recovery.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    assert.equal(f.requests.at(-1)?.url, "https://resolved-offline.test/backend-api/codex/responses");
    const outputs = readdirSync(f.directory).filter((file) => !beforeFiles.has(file) && file.endsWith(".jsonl"));
    assert.equal(outputs.length, 1, JSON.stringify(f.notifications));
    const exported = SessionManager.open(join(f.directory, outputs[0]));
    const replay = canonical(exported);
    assert.deepEqual(replay.slice(2), JSON.parse(JSON.stringify(split.suffix.map(resetHistoricalUsage))));
    assert.equal(
      exported.getEntries().some((entry) => entry.type === "custom"),
      false,
    );
    assert.notEqual(exported.getSessionId(), f.source.getSessionId());
    assert.equal(exported.getHeader()?.parentSession, undefined);
    assert.equal(
      getLastAssistantUsage(exported.getBranch())?.totalTokens ?? 0,
      0,
      "zero historical native usage baseline",
    );
    const recoveryCheckpoint = exported.getEntries().find((entry) => entry.type === "compaction");
    assert.equal(recoveryCheckpoint?.type === "compaction" && recoveryCheckpoint.usage?.totalTokens, 21);
    const exportedDetails = parseCheckpointDetails(
      recoveryCheckpoint?.type === "compaction" && recoveryCheckpoint.details,
    );
    assert.ok(exportedDetails);
    assert.deepEqual(exportedDetails.keptMessageFingerprints, []);
    // Actual serializer proof: zeroing historical accounting changes neither
    // model-visible input, tool IDs/signatures/media nor the system/tool envelope.
    const capture = async (messages: Parameters<typeof convertToLlm>[0]) => {
      let payload: unknown;
      for await (const _event of openaiCodexProvider().stream(
        model,
        normalizeContext({ messages: convertToLlm(messages) }),
        {
          apiKey,
          transport: "sse",
          maxRetries: 0,
          fetch: async () => {
            throw new Error("Offline serializer must abort before transport");
          },
          onPayload: (value) => {
            payload = rewriteCheckpointMarker(
              value,
              checkpointMarker(exportedDetails.checkpointId),
              exportedDetails.replacementHistory,
            );
            throw new DOMException("Offline payload capture", "AbortError");
          },
        },
      )) {
        /* drain the provider's handled abort */
      }
      assert.ok(payload);
      return payload as JsonObject;
    };
    assert.deepEqual(await capture([replay[0], replay[1], ...split.suffix]), await capture(replay));
    assert.equal(hash(sourceFile), sourceHash);
    assert.equal(JSON.stringify(f.settingsManager.getSettings()), settings);
    assert.equal(JSON.stringify(f.extensionSettings.get()), extensionSettings);
    assert.deepEqual(await f.credentials.list(), creds);
    assert.equal(f.source.getSessionFile(), sourceFile, "command never switches source");
    const next = await f.open(exported, false);
    assert.equal(next.model?.id, model.id, "native resume must ignore configured default B");
    assert.ok(
      (next.getContextUsage()?.tokens ?? 0) < 100000,
      "copied 900k usage cannot become the native context baseline",
    );
    await next.prompt("Explicit test continuation");
    const ordinary = f.requests.at(-1)?.payload;
    assert.ok(ordinary);
    for (const canary of [
      "TAIL_USER_CANARY",
      "TAIL_ARGUMENT_CANARY",
      "TAIL_RESULT_CANARY",
      "TAIL_CUSTOM_CANARY",
      "TAIL_SIGNATURE_CANARY",
    ]) {
      assert.equal(JSON.stringify(ordinary).split(canary).length - 1, 1, canary);
    }
    assert.equal(ordinary.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    const full = await next.compact();
    assert.ok(parseCheckpointDetails(full.details));
    assert.equal(f.requests.at(-1)?.payload.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.match(JSON.stringify(f.requests.at(-1)?.payload), /TAIL_RESULT_CANARY/);
    const exportedFile = exported.getSessionFile();
    assert.ok(exportedFile);
    const fork = SessionManager.forkFrom(exportedFile, f.directory, f.directory);
    assert.deepEqual(fork.buildSessionContext(), exported.buildSessionContext());
    assert.equal(hash(sourceFile), sourceHash);
    assert.equal(hash(backup), sourceHash);
    assert.ok(
      f.source
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant" && entry.message.usage.input === 900000,
        ),
      "original accounting remains untouched",
    );
    assert.match(JSON.stringify(f.notifications), /NEW session/);
  } finally {
    f.cleanup();
  }
});

for (const drift of [
  "decline",
  "branch",
  "model",
  "loadout",
  "settings",
  "pending",
  "session",
  "tree",
  "reload",
] as const) {
  test(`SDK explicit confirmation ${drift}: no recovery credentials, request, or export`, async () => {
    const f = await fixture();
    try {
      const requests = f.requests.length;
      const auth = f.authCount();
      const files = readdirSync(f.directory);
      const confirmations = f.confirmations();
      f.confirm(async () => {
        if (drift === "branch") f.source.appendCustomEntry("unknown-state", {});
        if (drift === "session") f.source.newSession();
        if (drift === "tree") await f.session.navigateTree(f.source.getBranch()[0].id, { summarize: false });
        if (drift === "reload") await f.session.reload();
        if (drift === "model") {
          await f.session.setModel({ ...model, id: "different-model" });
          // setModel itself resolves provider auth; recovery must not add another.
        }
        if (drift === "loadout") f.session.setActiveToolsByName([]);
        if (drift === "settings") f.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
        if (drift === "pending") await f.session.followUp("Queued work must fence recovery");
        return drift !== "decline";
      });
      await f.session.prompt("/codex-compact");
      assert.equal(f.confirmations(), confirmations, "recovery never opens canonical/native confirmation");
      assert.equal(f.requests.length, requests);
      assert.equal(f.authCount(), auth + (drift === "model" ? 1 : 0));
      assert.deepEqual(readdirSync(f.directory), files);
    } finally {
      f.cleanup();
    }
  });
}

test("SDK cold native reopen with unchanged synthetic loadout offers without warming or observation", async () => {
  const f = await fixture();
  try {
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const before = hash(sourceFile);
    const cold = await f.open(SessionManager.open(sourceFile));
    assert.deepEqual(cold.getActiveToolNames(), f.session.getActiveToolNames());
    const files = readdirSync(f.directory);
    const requests = f.requests.length;
    const auth = f.authCount();
    const notifications = f.notifications.length;
    // Native reopen/bind only: no ordinary prompt, warm-up, or injected loadout evidence.
    await cold.prompt("/codex-compact");
    assert.equal(f.requests.length, requests);
    assert.equal(f.authCount(), auth);
    assert.equal(hash(sourceFile), before);
    assert.deepEqual(readdirSync(f.directory), files);
    assert.equal(f.notifications.length, notifications + 1);
    assert.match(f.notifications.at(-1)?.message ?? "", /^Recovery OFFER ONLY:/);
    assert.match(f.notifications.at(-1)?.message ?? "", /confirm-recovery [a-f0-9-]{36}/);
    assert.equal(f.widgets.size, 0, "an unchanged cold synthetic loadout reaches only a read-only offer");
  } finally {
    f.cleanup();
  }
});

test("SDK cold reopened loadout mismatch reports fixed unavailable with zero auth/request/export", async () => {
  const f = await fixture();
  try {
    const cold = await f.open(f.source);
    cold.setActiveToolsByName([]); // No ordinary turn establishes evidence for this cold loadout.
    const files = readdirSync(f.directory);
    const requests = f.requests.length;
    const auth = f.authCount();
    const notifications = f.notifications.length;
    await cold.prompt("/codex-compact");
    assert.equal(f.requests.length, requests);
    assert.equal(f.authCount(), auth);
    assert.deepEqual(readdirSync(f.directory), files);
    assert.equal(f.notifications.length, notifications + 1);
    const warning = f.notifications.at(-1);
    assert.ok(warning);
    assert.match(warning.message, /unavailable.*\[loadout_mismatch\]/);
  } finally {
    f.cleanup();
  }
});

test("SDK committed export reports once and settles before held close, with no post-publication timeout", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let closeHeld = false;
  let opened = false;
  try {
    f.timeout(20);
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const before = hash(sourceFile);
    const files = new Set(readdirSync(f.directory));
    const notifications = f.notifications.length;
    const open = fsPromises.open;
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      opened = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeHeld = true;
        started.resolve();
        await release.promise;
        try {
          await close();
        } finally {
          closeHeld = false;
          closed.resolve();
        }
      });
      return handle;
    });
    vi.useFakeTimers();
    const command = f.session.prompt("/codex-compact");
    await started.promise;
    const outputs = readdirSync(f.directory).filter((name) => !files.has(name) && name.endsWith(".jsonl"));
    assert.equal(outputs.length, 1);
    const path = join(f.directory, outputs[0]);
    const sessionId = SessionManager.open(path).getSessionId();
    const messages = f.notifications.slice(notifications);
    assert.equal(messages.length, 1, "success must precede asynchronous close cleanup");
    assert.equal(messages[0].level, "info");
    assert.ok(messages[0].message.includes(`NEW session ${sessionId} at ${path}.`));
    await command;
    assert.equal(closeHeld, true, "command settles via the cancelled race, not held cleanup");
    assert.equal(f.widgets.size, 0);
    await vi.advanceTimersByTimeAsync(1000);
    assert.deepEqual(f.notifications.slice(notifications), messages, "no timeout/failure or duplicate success");
    assert.equal(hash(sourceFile), before);
    assert.equal(SessionManager.open(path).getSessionId(), sessionId);
  } finally {
    vi.useRealTimers();
    release.resolve();
    if (opened) await closed.promise;
    // Let the writer finish its directory-descriptor cleanup after file close.
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.cleanup();
  }
});

test("SDK completed export survives a throwing late notification", async () => {
  const f = await fixture();
  try {
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const before = hash(sourceFile);
    const files = new Set(readdirSync(f.directory));
    const notify = f.ui.notify;
    vi.spyOn(f.ui, "notify").mockImplementation((message, level) => {
      if (message.startsWith("Recovery exported")) throw new Error("Synthetic late UI failure");
      notify(message, level);
    });
    await f.session.prompt("/codex-compact");
    const outputs = readdirSync(f.directory).filter((file) => !files.has(file) && file.endsWith(".jsonl"));
    assert.equal(outputs.length, 1);
    assert.ok(SessionManager.open(join(f.directory, outputs[0])).getSessionId());
    assert.equal(hash(sourceFile), before);
  } finally {
    f.cleanup();
  }
});

test("SDK explicit rescue never retries even a retryable HTTP failure", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    const files = readdirSync(f.directory);
    f.hold(async () => new Response("synthetic offline failure", { status: 500 }));
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests + 1);
    assert.deepEqual(f.streamOptions.at(-1), { maxRetries: 0, transport: "sse" });
    assert.deepEqual(readdirSync(f.directory), files);
    assert.match(JSON.stringify(f.notifications), /remote_http_error; HTTP 500/);
  } finally {
    f.cleanup();
  }
});

test("SDK auth-time branch divergence discards continuation before transport", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    const files = readdirSync(f.directory);
    f.authHook(async () => {
      f.source.appendCustomEntry("changed-during-auth", {});
    });
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests);
    assert.deepEqual(readdirSync(f.directory), files);
  } finally {
    f.cleanup();
  }
});

for (const phase of ["auth", "body"] as const) {
  test(`SDK recovery Escape during ${phase} cancels owned work without export or stale notification`, async () => {
    const f = await fixture();
    try {
      const sourceFile = f.source.getSessionFile();
      assert.ok(sourceFile);
      const sourceHash = hash(sourceFile);
      const requests = f.requests.length;
      const files = readdirSync(f.directory);
      const notifications = f.notifications.length;
      const started = Promise.withResolvers<void>();
      const late = Promise.withResolvers<void>();
      if (phase === "auth")
        f.authHook(async () => {
          started.resolve();
          await late.promise;
        });
      else {
        f.onFetch(() => started.resolve());
        f.hold(
          async (signal) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  signal?.addEventListener(
                    "abort",
                    () => controller.error(new DOMException("Synthetic cancellation", "AbortError")),
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        );
      }
      const command = f.session.prompt("/codex-compact");
      await started.promise;
      f.cancelProgress();
      await command;
      late.resolve();
      assert.equal(f.requests.length, requests + (phase === "body" ? 1 : 0));
      assert.deepEqual(readdirSync(f.directory), files);
      assert.equal(hash(sourceFile), sourceHash);
      assert.equal(f.notifications.length, notifications);
    } finally {
      f.cleanup();
    }
  });
}

for (const phase of ["auth", "body"] as const) {
  for (const keypress of ["\u001b[97;1u", "\u001b", "\u0003"]) {
    test(`SDK held ${phase} ignores confirmation Enter release, but new key ${JSON.stringify(keypress)} cancels synchronously without consuming`, async () => {
      const f = await fixture();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let requestSignal: AbortSignal | null | undefined;
      try {
        const sourceFile = f.source.getSessionFile();
        assert.ok(sourceFile);
        const before = hash(sourceFile);
        const files = readdirSync(f.directory);
        const notifications = f.notifications.length;
        if (phase === "auth")
          f.authHook(async () => {
            started.resolve();
            await release.promise;
          });
        else
          f.hold(async (signal) => {
            requestSignal = signal;
            started.resolve();
            await release.promise;
            return sse(true);
          });
        const command = f.session.prompt("/codex-compact");
        await started.promise;
        assert.equal(f.widgets.size, 1);
        assert.equal(f.input("\u001b[13;1:3u"), undefined, "Kitty Enter release passes through");
        assert.equal(f.widgets.size, 1, "release must not retire newly authorized work");
        if (phase === "body") assert.equal(requestSignal?.aborted, false);
        assert.equal(f.input(keypress), undefined, "real new input remains available to other UI");
        assert.equal(f.widgets.size, 0, "new key retires the owned widget synchronously");
        if (phase === "body") assert.equal(requestSignal?.aborted, true);
        await command;
        release.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(readdirSync(f.directory), files);
        assert.equal(hash(sourceFile), before);
        assert.equal(f.notifications.length, notifications);
      } finally {
        release.resolve();
        f.cleanup();
      }
    });
  }
}

test("SDK overlapping recovery commands share one cancellable idle owner", async () => {
  const f = await fixture();
  try {
    const files = readdirSync(f.directory);
    const started = Promise.withResolvers<void>();
    f.onFetch(() => started.resolve());
    f.hold(
      async (signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Synthetic cancellation", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const first = f.session.prompt("/codex-compact");
    await started.promise;
    const requests = f.requests.length;
    const auth = f.authCount();
    const confirmations = f.confirmations();
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests);
    assert.equal(f.authCount(), auth);
    assert.equal(f.confirmations(), confirmations);
    assert.match(JSON.stringify(f.notifications), /other recovery export/);
    f.cancelProgress();
    await first;
    assert.deepEqual(readdirSync(f.directory), files);
  } finally {
    f.cleanup();
  }
});

for (const mixed of [false, true]) {
  test(`disk export → fork → native A resume → exact ordinary/full/replay wire (mixed suffix=${mixed}, default B)`, async () => {
    const f = await fixture();
    try {
      const sourceFile = f.source.getSessionFile();
      assert.ok(sourceFile);
      const sourceHash = hash(sourceFile);
      const sourceRecords = structuredClone(f.source.getEntries());
      const sourceProjection = canonical(f.source);
      const prior = parseCheckpointDetails(
        f.source
          .getBranch()
          .filter((entry) => entry.type === "compaction")
          .at(-1)?.details,
      );
      assert.ok(prior);
      const historical = splitRecoveryContext(sourceProjection.slice(1), prior.checkpointId, 2000).suffix;
      const user = {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "REPEATED_OCCURRENCE" },
          { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        timestamp: 2,
      };
      const suffix = mixed
        ? [
            ...historical,
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "HISTORICAL_B_CANARY" }],
              provider: model.provider,
              api: model.api,
              model: "default-B",
              stopReason: "stop" as const,
              timestamp: 30,
              usage: {
                input: 900000,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 900001,
                cost: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0, total: 10 },
              },
            },
            user,
            structuredClone(user),
          ]
        : [user, structuredClone(user)];
      const details = createCheckpointDetails({
        modelId: model.id,
        replacementHistory: [{ type: "compaction", encrypted_content: "synthetic-reopen" }],
        keptMessages: [],
      });
      const result = await exportRecoverySession({
        cwd: f.directory,
        sessionDir: f.directory,
        sourceSessionId: f.source.getSessionId(),
        sourceEntryIds: f.source.getEntries().map((entry) => entry.id),
        head: sourceProjection[0] as Parameters<typeof exportRecoverySession>[0]["head"],
        details,
        suffix,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      const exportedHash = hash(result.path);
      const reopened = SessionManager.open(result.path);
      const fork = SessionManager.forkFrom(result.path, f.directory, f.directory);
      const forkFile = fork.getSessionFile();
      assert.ok(forkFile);
      assert.deepEqual(fork.buildSessionContext(), reopened.buildSessionContext());
      assert.deepEqual(canonical(fork).slice(2), JSON.parse(JSON.stringify(suffix.map(resetHistoricalUsage))));
      assert.equal(getLastAssistantUsage(fork.getBranch())?.totalTokens ?? 0, 0);
      const next = await f.open(SessionManager.open(forkFile), false);
      assert.equal(next.model?.id, model.id);
      assert.equal(next.model?.provider, model.provider);
      assert.equal(fork.getEntries().filter((entry) => entry.type === "model_change").length, 1);
      assert.ok((next.getContextUsage()?.tokens ?? 0) < 100000);
      // Independent real provider serializer; compare entire ordered occurrence
      // arrays, including signatures/media/call_id/results, not string membership.
      const capture = async (messages: Parameters<typeof convertToLlm>[0], checkpoint: typeof details) => {
        let payload: JsonObject | undefined;
        for await (const _event of openaiCodexProvider().stream(
          model,
          normalizeContext({ messages: convertToLlm(messages) }),
          {
            apiKey,
            transport: "sse",
            maxRetries: 0,
            fetch: async () => {
              throw new Error("Capture must not transport");
            },
            onPayload: (value) => {
              payload = rewriteCheckpointMarker(
                value,
                checkpointMarker(checkpoint.checkpointId),
                checkpoint.replacementHistory,
              ) as JsonObject;
              throw new DOMException("Offline capture", "AbortError");
            },
          },
        )) {
          /* drain handled capture abort */
        }
        assert.ok(payload);
        return JSON.parse(JSON.stringify(payload)) as JsonObject; // Match actual JSON wire omission of undefined.
      };
      const activeManager = next.sessionManager;
      const firstExpected = await capture(
        [...canonical(activeManager), { role: "user", content: "FIRST_CONTINUATION", timestamp: 40 }],
        details,
      );
      await next.prompt("FIRST_CONTINUATION");
      const ordinary = f.requests.at(-1)?.payload;
      assert.ok(ordinary);
      assert.deepEqual(ordinary.input, firstExpected.input);
      assert.equal(ordinary.model, model.id);
      assert.equal(ordinary.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
      assert.equal(JSON.stringify(ordinary.input).split("REPEATED_OCCURRENCE").length - 1, 2);
      if (mixed) {
        for (const canary of [
          "TAIL_USER_CANARY",
          "TAIL_ARGUMENT_CANARY",
          "TAIL_RESULT_CANARY",
          "TAIL_SIGNATURE_CANARY",
          "TAIL_CUSTOM_CANARY",
          "HISTORICAL_B_CANARY",
        ])
          assert.equal(JSON.stringify(ordinary.input).split(canary).length - 1, 1, canary);
        assert.equal(
          ordinary.input.filter((item: JsonObject) => item.type === "function_call" && item.call_id === "call_tail")
            .length,
          1,
        );
        assert.equal(
          ordinary.input.filter(
            (item: JsonObject) => item.type === "function_call_output" && item.call_id === "call_tail",
          ).length,
          1,
        );
      }
      const fullExpected = await capture(canonical(activeManager), details);
      const full = await next.compact();
      const fullWire = f.requests.at(-1)?.payload;
      assert.ok(fullWire);
      assert.deepEqual(
        fullWire.input.filter((item: JsonObject) => item.type !== "compaction_trigger"),
        fullExpected.input,
      );
      const laterDetails = parseCheckpointDetails(full.details);
      assert.ok(laterDetails);
      const afterFull = canonical(activeManager);
      const replayExpected = await capture(
        [...afterFull, { role: "user", content: "SECOND_CONTINUATION", timestamp: 50 }],
        laterDetails,
      );
      await next.prompt("SECOND_CONTINUATION");
      const replay = f.requests.at(-1)?.payload;
      assert.ok(replay);
      assert.deepEqual(
        replay.input,
        replayExpected.input,
        "all retained occurrences replay once after full compaction",
      );
      assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
      assert.equal(replay.model, model.id);
      assert.equal(hash(result.path), exportedHash, "fork lifecycle never mutates exported source");
      assert.equal(hash(sourceFile), sourceHash);
      assert.deepEqual(f.source.getEntries(), sourceRecords, "original accounting/control records unchanged");
      // Synthetic opaque proves local topology/serialization only, not backend absorption.
    } finally {
      f.cleanup();
    }
  });
}

for (const phase of ["confirmation", "body"] as const) {
  for (const drift of ["provider", "headless", "ui"] as const) {
    test(`real SDK ${phase} ${drift} replacement fences auth/publication`, async () => {
      const f = await fixture();
      try {
        assert.equal(
          f.runtime.getProvider(model.provider),
          f.runtime.getProvider(model.provider),
          "stable public getProvider reference",
        );
        const files = readdirSync(f.directory);
        const auth = f.authCount();
        const requests = f.requests.length;
        const notifications = f.notifications.length;
        const replace = async () => {
          if (drift === "provider") {
            const before = f.runtime.getProvider(model.provider);
            f.runtime.registerNativeProvider({
              ...f.provider,
              auth: {
                apiKey: {
                  name: "Replacement offline",
                  resolve: async () => ({
                    auth: { apiKey, baseUrl: "https://resolved-offline.test/backend-api/codex" },
                  }),
                },
              },
            });
            assert.notEqual(f.runtime.getProvider(model.provider), before);
          } else
            await f.session.bindExtensions({
              mode: drift === "headless" ? "print" : "tui",
              ...(drift === "ui" ? { uiContext: { ...f.ui } } : {}),
            });
        };
        if (phase === "confirmation")
          f.confirm(async () => {
            await replace();
            return true;
          });
        else
          f.hold(async () => {
            await replace();
            return sse(true);
          });
        await f.session.prompt("/codex-compact");
        assert.equal(f.authCount(), auth + (phase === "body" ? 1 : 0));
        assert.equal(f.requests.length, requests + (phase === "body" ? 1 : 0));
        assert.deepEqual(readdirSync(f.directory), files);
        assert.equal(
          f.notifications.length,
          notifications + (phase === "confirmation" && drift !== "headless" ? 1 : 0),
        );
        if (phase === "confirmation" && drift !== "headless")
          assert.match(f.notifications.at(-1)?.message ?? "", /no request was sent/);
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const phase of ["auth", "body", "staging"] as const) {
  for (const action of ["dispose", "reload", "headless", "ui"] as const) {
    test(`progress ${action} during held ${phase} fences late publication`, async () => {
      const f = await fixture();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let requestSignal: AbortSignal | null | undefined;
      try {
        const files = readdirSync(f.directory);
        const notifications = f.notifications.length;
        if (phase === "auth")
          f.authHook(async () => {
            started.resolve();
            await release.promise;
          });
        if (phase === "body")
          f.hold(async (signal) => {
            requestSignal = signal;
            started.resolve();
            await release.promise;
            return sse(true);
          });
        if (phase === "staging") {
          const open = fsPromises.open;
          vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              started.resolve();
              await release.promise;
            });
            return handle;
          });
        }
        const command = f.session.prompt("/codex-compact");
        await started.promise;
        if (action === "dispose") f.disposeProgress();
        else if (action === "reload") await f.session.reload();
        else
          await f.session.bindExtensions({
            mode: action === "headless" ? "print" : "tui",
            ...(action === "ui" ? { uiContext: { ...f.ui } } : {}),
          });
        if ((action === "dispose" || action === "reload") && phase === "body")
          assert.equal(requestSignal?.aborted, true);
        if (action === "headless" || action === "ui") {
          // No lifecycle cleanup has run. Rebound owner must be rejected at the
          // next public continuation boundary, without clearing the replacement UI.
          release.resolve();
        }
        await command;
        release.resolve();
        // Observe the held writer's own cleanup, not just command settlement.
        await vi.waitFor(() => assert.deepEqual(readdirSync(f.directory), files));
        assert.equal(f.notifications.length, notifications);
      } finally {
        release.resolve();
        f.cleanup();
      }
    });
  }
}

for (const phase of ["body", "staging"] as const) {
  for (const userFirst of [false, true]) {
    test(`SDK owned ${phase} deadline (user cancellation first=${userFirst})`, async () => {
      const f = await fixture();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        f.timeout(20);
        const files = readdirSync(f.directory);
        const notifications = f.notifications.length;
        if (phase === "body")
          f.hold(async () => {
            started.resolve();
            await release.promise;
            return sse(true);
          });
        else {
          const open = fsPromises.open;
          vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              started.resolve();
              await release.promise;
            });
            return handle;
          });
        }
        vi.useFakeTimers();
        const command = f.session.prompt("/codex-compact");
        await started.promise;
        if (userFirst) f.cancelProgress();
        await vi.advanceTimersByTimeAsync(21);
        await command;
        const messages = f.notifications.slice(notifications);
        assert.equal(messages.length, userFirst ? 0 : 1);
        if (!userFirst) assert.match(messages[0].message, /remote_timeout/);
        vi.useRealTimers();
        release.resolve();
        await vi.waitFor(() => assert.deepEqual(readdirSync(f.directory), files));
        assert.equal(f.notifications.length, notifications + messages.length);
      } finally {
        vi.useRealTimers();
        release.resolve();
        f.cleanup();
      }
    });
  }
}

test("SDK response-time lineage drift cannot export accepted opaque result", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    const files = readdirSync(f.directory);
    f.onFetch(() => f.source.appendCustomEntry("changed-during-response", {}));
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests + 1, JSON.stringify(f.notifications));
    assert.deepEqual(readdirSync(f.directory), files);
  } finally {
    f.cleanup();
  }
});
