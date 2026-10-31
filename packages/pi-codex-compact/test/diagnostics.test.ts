import assert from "node:assert/strict";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { createDiagnosticTrace } from "../src/diagnostics.js";
import { compactionError, failureFrom } from "../src/failure.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { withoutDiagnosticSummary } from "./diagnostic-assertions.js";
import { createMockContext, createMockPi } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "offline-model",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.x`;
const secret = "https://USER_SECRET:PASS_SECRET@example.test/?key=KEY_SECRET Authorization: Bearer TOKEN_SECRET";

function settingsRuntime(allowCanonicalHistory = true): CodexCompactSettingsRuntime {
  const state = {
    kind: "loaded" as const,
    path: "/unused/offline-settings.json",
    document: {},
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      allowCanonicalHistory,
      notifyOnFallback: false,
      maxRetries: 0,
    },
  };
  return {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async () => assert.fail("diagnostics must not change settings"),
    flush: async () => {},
  };
}

for (const mode of ["tui", "json", "rpc"] as const) {
  test(`diagnostics command is session-bound, read-only and guarded in ${mode}`, async () => {
    const mock = createMockPi();
    createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(mock.pi);
    const session = SessionManager.inMemory();
    const { ctx, notifications } = createMockContext({ mode, hasUI: true, sessionManager: session });
    const trace = createDiagnosticTrace(session.getSessionId(), "manual");
    trace.phase("auth");
    trace.finish("failure", "authentication_timeout", "stage");
    const command = mock.commands.get("codex-compact");
    assert.ok(command);
    await command.handler("diagnostics", ctx);
    assert.equal(notifications.length, mode === "tui" ? 1 : 0);
    if (mode === "tui") assert.match(notifications[0].message, /authentication_timeout; timeout=stage/);
    assert.deepEqual(mock.sentMessages, []);
    assert.deepEqual(mock.sentUserMessages, []);
    assert.deepEqual(mock.entries, []);
    const other = createMockContext({ mode, hasUI: true, sessionManager: SessionManager.inMemory() });
    await command.handler("diagnostics", other.ctx);
    if (mode === "tui") assert.equal(other.notifications[0].message, "No diagnostics available for this session.");
  });
}

test("diagnostics command suppresses a retired UI even when recent rows are in memory", async () => {
  const mock = createMockPi();
  createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(mock.pi);
  const session = SessionManager.inMemory();
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, sessionManager: session });
  createDiagnosticTrace(session.getSessionId(), "manual").phase("auth");
  const reading = mock.commands.get("codex-compact")?.handler("diagnostics", ctx);
  await mock.events.get("session_shutdown")?.[0]({ reason: "reload" }, ctx);
  await reading;
  assert.deepEqual(notifications, []);
});

const cases = [
  ["auth throw", "authentication_failed"],
  ["auth unavailable", "credentials_unavailable"],
  ["auth missing key", "credentials_unavailable"],
  ["provider missing", "provider_unavailable"],
  ["provider throw", "provider_unavailable"],
  ["malformed checkpoint", "checkpoint_malformed"],
  ["incompatible model", "checkpoint_incompatible"],
  ["incompatible provider", "checkpoint_incompatible"],
  ["incompatible API", "checkpoint_incompatible"],
  ["missing anchor", "checkpoint_projection_failed"],
  ["wrong lineage", "checkpoint_projection_failed"],
  ["live loadout mismatch", "loadout_mismatch"],
  ["wire loadout mismatch", "loadout_mismatch"],
  ["state divergence", "state_divergence"],
  ["HTTP failure", "remote_http_error; HTTP 401"],
] as const;

for (const [scenario, code] of cases) {
  test(`opaque cancellation reports the known safe phase: ${scenario}`, async () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "Older offline request", timestamp: 1 });
    const kept = { role: "user" as const, content: "Kept offline request", timestamp: 2 };
    const keptId = session.appendMessage(kept);
    const details = createCheckpointDetails({
      modelId: model.id,
      checkpointId: "offline-checkpoint",
      replacementHistory: [{ type: "compaction", encrypted_content: "offline-opaque" }],
      keptMessages: scenario === "wrong lineage" ? [{ ...kept, content: "other" }] : [kept],
    });
    session.appendCompaction(
      scenario === "missing anchor" ? "wrong anchor" : fallbackSummary(details.checkpointId),
      keptId,
      123,
      scenario === "malformed checkpoint" ? { ...details, replacementHistory: [] } : details,
    );
    const laterId = session.appendMessage({ role: "user", content: "Later offline task", timestamp: 3 });
    const before = session.getEntries();
    const mock = createMockPi();
    let prompt = "";
    let requests = 0;
    const auth = vi.fn(async () => {
      if (scenario === "auth throw") throw new Error(secret, { cause: { apiKey: secret } });
      if (scenario === "auth unavailable") return { ok: false as const, error: secret };
      return { ok: true as const, apiKey: scenario === "auth missing key" ? undefined : apiKey };
    });
    const actual = openaiCodexProvider();
    const provider: Provider = {
      ...actual,
      stream(requestModel, context, options) {
        return actual.stream(requestModel, context, {
          ...options,
          onPayload: async (payload, payloadModel) =>
            options?.onPayload?.(
              scenario === "wire loadout mismatch" ? { ...payload, tools: [{ name: secret }] } : payload,
              payloadModel,
            ),
        });
      },
    };
    createCodexCompactExtension({
      settingsRuntime: settingsRuntime(),
      fetch: async () => {
        requests++;
        if (scenario === "state divergence") prompt = "Changed offline prompt";
        if (scenario === "HTTP failure")
          return new Response(secret, { status: 401, statusText: secret, headers: { "X-Secret": secret } });
        const item = { type: "compaction", encrypted_content: "new-offline-opaque" };
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
        );
      },
    })(mock.pi);
    const { ctx, notifications } = createMockContext({
      model:
        scenario === "incompatible model"
          ? { ...model, id: "other" }
          : scenario === "incompatible provider"
            ? { ...model, provider: "other" }
            : scenario === "incompatible API"
              ? { ...model, api: "openai-responses" }
              : model,
      hasUI: true,
      getSystemPrompt: () => prompt,
      sessionManager: session,
      modelRegistry: {
        getApiKeyAndHeaders: auth,
        getProvider: () => {
          if (scenario === "provider throw") throw new Error(secret, { cause: secret });
          return scenario === "provider missing" ? undefined : provider;
        },
      },
    });
    if (scenario === "wire loadout mismatch") {
      // Observe exact wire tools on a fresh ordinary preparation. The real
      // provider catches the later onPayload rejection into its error event.
      await mock.events.get("context")?.[0]({ messages: session.buildSessionContext().messages }, ctx);
      await mock.events.get("before_provider_request")?.[0]({ payload: { input: [], tools: [] } }, ctx);
    }
    if (scenario === "live loadout mismatch") prompt = "Unpersisted offline prompt";
    const result = await mock.events.get("session_before_compact")?.[0](
      {
        type: "session_before_compact",
        branchEntries: session.getBranch(),
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
        preparation: {
          firstKeptEntryId: laterId,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
        },
      } satisfies SessionBeforeCompactEvent,
      ctx,
    );
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(session.getEntries(), before, "no checkpoint or history mutation");
    assert.equal(requests, scenario === "state divergence" || scenario === "HTTP failure" ? 1 : 0);
    assert.equal(
      auth.mock.calls.length,
      scenario.startsWith("incompatible") || scenario === "malformed checkpoint" ? 0 : 1,
    );
    assert.equal(notifications.length, 1, "opaque cancellation warns even with notifyOnFallback false");
    assert.match(notifications[0].message, /cancelled to preserve the existing opaque checkpoint/);
    assert.ok(notifications[0].message.includes(`[${code}]`));
    if (!scenario.startsWith("incompatible")) assert.doesNotMatch(notifications[0].message, /original Codex model/);
    assert.doesNotMatch(
      JSON.stringify(notifications),
      /USER_SECRET|PASS_SECRET|KEY_SECRET|TOKEN_SECRET|example\.test|Authorization/,
    );
  });
}

test("safe diagnostics discard forged error fields and reject nonnumeric or out-of-range HTTP status", () => {
  const error = Object.assign(new Error(secret, { cause: secret }), { code: secret, status: 401, httpStatus: 401 });
  assert.deepEqual(failureFrom(error, "remote_provider_error"), { code: "remote_provider_error" });
  assert.deepEqual(failureFrom(Reflect.apply(compactionError, undefined, [secret, secret]), "remote_provider_error"), {
    code: "local_compaction_failed",
  });
  assert.deepEqual(
    failureFrom(Reflect.apply(compactionError, undefined, ["remote_http_error", "401"]), "local_compaction_failed"),
    { code: "remote_http_error" },
  );
  for (const status of [NaN, Infinity, -1, 0, 99, 600, 401.5]) {
    assert.deepEqual(failureFrom(compactionError("remote_http_error", status), "local_compaction_failed"), {
      code: "remote_http_error",
    });
  }
  assert.deepEqual(failureFrom(compactionError("remote_provider_error", 401), "local_compaction_failed"), {
    code: "remote_provider_error",
  });
  assert.deepEqual(
    failureFrom(
      { code: "remote_context_window_exceeded", error: { code: "context_window_exceeded" } },
      "remote_provider_error",
    ),
    { code: "remote_provider_error" },
  );
  assert.deepEqual(failureFrom(compactionError("remote_context_window_exceeded", 400), "local_compaction_failed"), {
    code: "remote_context_window_exceeded",
  });
  const getters = Object.defineProperties(
    {},
    {
      code: { get: () => assert.fail("must not inspect arbitrary errors") },
      error: { get: () => assert.fail("must not inspect arbitrary errors") },
      response: { get: () => assert.fail("must not inspect arbitrary errors") },
      message: { get: () => assert.fail("must not inspect arbitrary errors") },
      cause: { get: () => assert.fail("must not inspect arbitrary errors") },
      status: { get: () => assert.fail("must not inspect arbitrary errors") },
    },
  );
  assert.deepEqual(failureFrom(getters, "remote_provider_error"), { code: "remote_provider_error" });
});

for (const gate of ["denied", "required", "aborted"] as const) {
  test(`opaque consent/caller cancellation remains non-provider and source-free: ${gate}`, async () => {
    const session = SessionManager.inMemory();
    const keptId = session.appendMessage({ role: "user", content: secret, timestamp: 1 });
    const details = createCheckpointDetails({
      modelId: model.id,
      replacementHistory: [{ type: "compaction", encrypted_content: secret }],
      keptMessages: [],
    });
    session.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details);
    const mock = createMockPi();
    const auth = vi.fn(async () => assert.fail("consent cancellation cannot resolve credentials"));
    const fetch = vi.fn<typeof globalThis.fetch>();
    createCodexCompactExtension({ settingsRuntime: settingsRuntime(false), fetch })(mock.pi);
    const { ctx, notifications } = createMockContext({
      model: gate === "aborted" ? { ...model, id: "incompatible" } : model,
      hasUI: true,
      mode: gate === "required" ? "rpc" : "tui",
      confirm: async () => false,
      sessionManager: session,
      modelRegistry: { getApiKeyAndHeaders: auth },
    });
    const controller = new AbortController();
    if (gate === "aborted") controller.abort(new Error(secret));
    assert.deepEqual(
      await mock.events.get("session_before_compact")?.[0](
        { branchEntries: session.getBranch(), signal: controller.signal },
        ctx,
      ),
      { cancel: true },
    );
    assert.equal(auth.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
    assert.deepEqual(
      notifications,
      gate === "aborted"
        ? []
        : [
            {
              message: `Compaction cancelled to preserve the existing opaque checkpoint. ${gate === "required" ? "[canonical_consent_required] Canonical-history authorization is required." : "[canonical_consent_denied] Canonical history was not authorized."}`,
              level: "warning",
            },
          ],
    );
    assert.doesNotMatch(
      JSON.stringify(notifications),
      /USER_SECRET|PASS_SECRET|KEY_SECRET|TOKEN_SECRET|example\.test|Authorization|remote_provider_error|remote_http_error/,
    );
  });
}

test("throwing diagnostic UI cannot turn an authentication failure on opaque history into native fallback", async () => {
  const session = SessionManager.inMemory();
  const keptId = session.appendMessage({ role: "user", content: "offline", timestamp: 1 });
  const details = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
    keptMessages: [],
  });
  session.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details);
  const mock = createMockPi();
  createCodexCompactExtension({ settingsRuntime: settingsRuntime() })(mock.pi);
  const { ctx } = createMockContext({
    model,
    hasUI: true,
    sessionManager: session,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        throw new Error(secret);
      },
    },
  });
  const notify = vi.spyOn((ctx as ExtensionContext).ui, "notify").mockImplementation(() => {
    throw new Error(secret);
  });
  const result = await mock.events.get("session_before_compact")?.[0](
    { branchEntries: session.getBranch(), signal: new AbortController().signal },
    ctx,
  );
  assert.deepEqual(result, { cancel: true });
  assert.equal(notify.mock.calls.length, 1);
  assert.equal(
    withoutDiagnosticSummary(notify.mock.calls[0][0]),
    "Compaction cancelled to preserve the existing opaque checkpoint. [authentication_failed]",
  );
});
