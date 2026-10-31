import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { CANONICAL_HISTORY_NOTICE } from "../src/authorization.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";
import { withoutDiagnosticSummaries } from "./diagnostic-assertions.js";
import { createMockContext, createMockPi, stableProvider } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://wrong-destination.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64")}.x`;
const destination = "https://authorized-destination.test/backend-api/codex";

async function fixture(
  options: {
    mode?: "tui" | "rpc" | "print";
    allowed?: boolean;
    failure?: boolean;
    baseUrl?: string;
    confirm?: () => Promise<unknown>;
    beforeAuth?: () => Promise<void>;
    beforeTransport?: () => void;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "codex-consent-"));
  const path = join(directory, "pi-codex-compact.json");
  const runtime = createCodexCompactSettingsRuntime(path);
  if (options.allowed) await runtime.update({ allowCanonicalHistory: true, maxRetries: 0 });
  const session = SessionManager.inMemory();
  const kept = session.appendMessage({ role: "user", content: "PRIVATE_HISTORY_CANARY", timestamp: 1 });
  const controller = new AbortController();
  const mock = createMockPi();
  let authCalls = 0;
  const requests: Array<{ url: string; headers: Headers }> = [];
  const dialogs: string[] = [];
  const dialogSignals: AbortSignal[] = [];
  const { ctx, notifications } = createMockContext({
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print",
    model,
    sessionManager: session,
    getSystemPrompt: () => "",
    confirm: async (title: string, message: string, opts: { signal: AbortSignal }) => {
      dialogs.push(`${title}\n${message}`);
      dialogSignals.push(opts.signal);
      assert.equal(opts.signal.aborted, false);
      return options.confirm ? options.confirm() : false;
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        authCalls += 1;
        await options.beforeAuth?.();
        return {
          ok: true,
          apiKey,
          baseUrl: options.baseUrl ?? destination,
          headers: { "X-Auth-Canary": "HEADER_SECRET" },
          env: { CODEX_SECRET: "ENV_SECRET" },
        };
      },
      getProvider: stableProvider(() => {
        const provider = openaiCodexProvider();
        return {
          ...provider,
          stream: ((requestModel, context, streamOptions) => {
            assert.equal(requestModel.baseUrl, options.baseUrl ?? destination);
            assert.deepEqual(streamOptions?.env, { CODEX_SECRET: "ENV_SECRET" });
            return provider.stream(requestModel, context, {
              ...streamOptions,
              onPayload: async (payload, payloadModel) => {
                const prepared = await streamOptions?.onPayload?.(payload, payloadModel);
                options.beforeTransport?.();
                return prepared;
              },
            });
          }) satisfies typeof provider.stream,
        };
      }),
    },
  });
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      if (options.failure)
        return new Response(JSON.stringify({ error: { message: `HEADER_SECRET ENV_SECRET ${String(url)}` } }), {
          status: 400,
        });
      const item = { type: "compaction", encrypted_content: "opaque" };
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  })(mock.pi);
  const compact = () =>
    mock.events.get("session_before_compact")?.[0](
      {
        type: "session_before_compact",
        branchEntries: session.getBranch(),
        reason: "manual",
        willRetry: false,
        signal: controller.signal,
        preparation: {
          firstKeptEntryId: kept,
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
  return {
    compact,
    mock,
    ctx,
    controller,
    session,
    runtime,
    path,
    requests,
    dialogs,
    dialogSignals,
    notifications,
    authCalls: () => authCalls,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const mode of ["tui", "rpc", "print"] as const) {
  test(`unconsented ${mode}: no credentials, transport, checkpoint, or native fallback`, async () => {
    const f = await fixture({ mode });
    try {
      assert.deepEqual(await f.compact(), { cancel: true });
      assert.equal(f.authCalls(), 0);
      assert.deepEqual(f.requests, []);
      assert.equal(
        f.session.getBranch().some((entry) => entry.type === "compaction"),
        false,
      );
      assert.deepEqual(
        f.notifications,
        mode === "print"
          ? []
          : [
              {
                message:
                  mode === "tui"
                    ? "Compaction cancelled. [canonical_consent_denied] Canonical history was not authorized."
                    : "Compaction cancelled. [canonical_consent_required] Canonical-history authorization is required.",
                level: "warning",
              },
            ],
      );
      assert.equal(f.dialogs.length, mode === "tui" ? 1 : 0);
      assert.doesNotMatch(
        JSON.stringify(f.dialogs),
        /PRIVATE_HISTORY_CANARY|HEADER_SECRET|ENV_SECRET|wrong-destination|authorized-destination/,
      );
      if (mode === "tui") assert.ok(f.dialogs[0].includes(CANONICAL_HISTORY_NOTICE));
    } finally {
      await f.cleanup();
    }
  });
}

test("allow once dispatches only to the resolved authorized URL and never persists consent", async () => {
  let allowed = true;
  const f = await fixture({ confirm: async () => allowed });
  try {
    assert.ok(await f.compact());
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, `${destination}/responses`);
    assert.equal(f.requests[0].headers.get("Authorization"), `Bearer ${apiKey}`);
    assert.equal(f.requests[0].headers.get("X-Auth-Canary"), "HEADER_SECRET");
    assert.equal(f.runtime.get().settings.allowCanonicalHistory, false);
    await assert.rejects(readFile(f.path), /ENOENT/);
    allowed = false;
    assert.deepEqual(await f.compact(), { cancel: true });
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(f.notifications), /HEADER_SECRET|ENV_SECRET|https:/);
  } finally {
    await f.cleanup();
  }
});

for (const change of ["abort", "branch", "tree", "reload", "shutdown", "uncertain", "throw"] as const) {
  test(`confirmation cannot authorize a stale or uncertain request: ${change}`, async () => {
    const answer = Promise.withResolvers<unknown>();
    const shown = Promise.withResolvers<void>();
    const f = await fixture({
      confirm: () => {
        shown.resolve();
        return answer.promise;
      },
    });
    try {
      const pending = f.compact();
      await shown.promise;
      if (change === "abort") f.controller.abort("SECRET_ABORT_REASON");
      if (change === "branch") f.session.appendMessage({ role: "user", content: "new branch", timestamp: 2 });
      if (change === "tree") await f.mock.events.get("session_tree")?.[0]({}, f.ctx);
      if (change === "reload") await f.mock.events.get("session_start")?.[0]({ reason: "reload" }, f.ctx);
      if (change === "shutdown") await f.mock.events.get("session_shutdown")?.[0]({ reason: "exit" }, f.ctx);
      if (change === "throw") answer.reject(new Error("HEADER_SECRET"));
      else answer.resolve(change === "uncertain" ? "yes" : true);
      assert.deepEqual(await pending, { cancel: true });
      assert.equal(f.authCalls(), 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.runtime.get().settings.allowCanonicalHistory, false);
      if (change === "branch") {
        assert.deepEqual(f.notifications, [
          {
            message:
              "Compaction cancelled. [preparation_branch_changed] The active branch changed after compaction preparation.",
            level: "warning",
          },
        ]);
      } else if (change === "uncertain" || change === "throw") {
        assert.deepEqual(f.notifications, [
          {
            message: "Compaction cancelled. [canonical_consent_denied] Canonical history was not authorized.",
            level: "warning",
          },
        ]);
      } else {
        assert.deepEqual(f.notifications, [], "aborted/retired owners cannot deliver a stale notification");
      }
      assert.doesNotMatch(JSON.stringify(f.notifications), /HEADER_SECRET|SECRET_ABORT_REASON/);
    } finally {
      await f.cleanup();
    }
  });
}

test("persistent explicit opt-in reloads privately, preserves unknown keys; legacy and invalid files deny", async () => {
  const f = await fixture({ mode: "print" });
  try {
    await writeFile(f.path, '{"enabled":true,"futureKey":{"kept":true}}');
    await f.runtime.reload();
    assert.deepEqual(await f.compact(), { cancel: true }, "legacy enabled is not consent");
    await f.runtime.update({ allowCanonicalHistory: true });
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    const loaded = createCodexCompactSettingsRuntime(f.path);
    assert.equal((await loaded.reload()).settings.allowCanonicalHistory, true);
    assert.deepEqual(loaded.get().document?.futureKey, { kept: true });
    assert.ok(await f.compact());
    for (const text of [
      '{"allowCanonicalHistory":"true"}',
      '{"allowCanonicalHistory":true,"maxRetries":9}',
      "{invalid",
    ]) {
      await writeFile(f.path, text);
      await f.runtime.reload();
      assert.equal(f.runtime.get().settings.allowCanonicalHistory, false);
      assert.deepEqual(await f.compact(), { cancel: true });
      assert.equal(await readFile(f.path, "utf8"), text);
    }
    assert.equal(f.requests.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("transport failure permits native fallback only after canonical consent", async () => {
  const f = await fixture({ allowed: true, failure: true });
  try {
    assert.equal(await f.compact(), undefined);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(withoutDiagnosticSummaries(f.notifications), [
      {
        message: "Codex remote compaction failed; using Pi compaction. [remote_http_error; HTTP 400]",
        level: "warning",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(f.notifications), /HEADER_SECRET|ENV_SECRET|authorized-destination/);
  } finally {
    await f.cleanup();
  }
});

for (const stage of ["authentication", "before transport"] as const) {
  test(`authorized branch divergence cancels at ${stage}, without dispatch or fallback`, async () => {
    const resolved = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const f = await fixture({
      allowed: true,
      beforeAuth:
        stage === "authentication"
          ? () => {
              started.resolve();
              return resolved.promise;
            }
          : undefined,
      beforeTransport:
        stage === "before transport"
          ? () => {
              f.session.appendMessage({ role: "user", content: "New branch", timestamp: 2 });
            }
          : undefined,
    });
    try {
      const pending = f.compact();
      if (stage === "authentication") {
        await started.promise;
        f.session.appendMessage({ role: "user", content: "New branch", timestamp: 2 });
        resolved.resolve();
      }
      assert.deepEqual(await pending, { cancel: true });
      assert.equal(f.requests.length, 0);
      assert.deepEqual(f.notifications, [
        {
          message:
            "Compaction cancelled. [preparation_branch_changed] The active branch changed after compaction preparation.",
          level: "warning",
        },
      ]);
      assert.equal(
        f.session.getBranch().some((entry) => entry.type === "compaction"),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("authorized destination userinfo and query secrets never enter notifications or persistence", async () => {
  const baseUrl = "https://USERINFO_CANARY:PASSWORD_CANARY@authorized-destination.test/backend-api/codex?QUERY_CANARY";
  const f = await fixture({ allowed: true, failure: true, baseUrl });
  try {
    assert.equal(await f.compact(), undefined);
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].url, /authorized-destination/);
    assert.equal(f.requests[0].headers.get("Authorization"), `Bearer ${apiKey}`);
    assert.doesNotMatch(
      JSON.stringify(f.notifications),
      /USERINFO_CANARY|PASSWORD_CANARY|QUERY_CANARY|HEADER_SECRET|ENV_SECRET/,
    );
    assert.doesNotMatch(
      JSON.stringify(f.session.getBranch()),
      /USERINFO_CANARY|PASSWORD_CANARY|QUERY_CANARY|HEADER_SECRET|ENV_SECRET/,
    );
    assert.doesNotMatch(
      await readFile(f.path, "utf8"),
      /USERINFO_CANARY|PASSWORD_CANARY|QUERY_CANARY|HEADER_SECRET|ENV_SECRET/,
    );
    assert.equal(model.baseUrl, "https://wrong-destination.test");
  } finally {
    await f.cleanup();
  }
});

for (const throwsUI of [false, true]) {
  test(`same-owner model invalidation during authentication is a safe cancellation (throwing UI ${throwsUI})`, async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      allowed: true,
      beforeAuth: () => {
        started.resolve();
        return release.promise;
      },
    });
    try {
      const notify = vi.spyOn((f.ctx as ExtensionContext).ui, "notify");
      if (throwsUI)
        notify.mockImplementation(() => {
          throw new Error("HEADER_SECRET");
        });
      const pending = f.compact();
      await started.promise;
      (f.ctx as ExtensionContext).model = {
        ...model,
        id: "MODEL_ID_SECRET",
        baseUrl: "https://USER_SECRET:PASS_SECRET@example.test/?key=KEY_SECRET",
      };
      release.resolve();
      assert.deepEqual(await pending, { cancel: true });
      assert.equal(f.requests.length, 0);
      assert.equal(f.authCalls(), 1);
      assert.equal(notify.mock.calls.length, 1);
      assert.equal(
        notify.mock.calls[0][0],
        "Compaction cancelled. [preparation_model_changed] The active model changed after compaction preparation.",
      );
      assert.doesNotMatch(
        JSON.stringify(notify.mock.calls),
        /MODEL_ID_SECRET|USER_SECRET|PASS_SECRET|KEY_SECRET|HEADER_SECRET/,
      );
    } finally {
      await f.cleanup();
    }
  });
}

for (const change of ["abort", "session", "reload", "shutdown"] as const) {
  test(`authentication continuation cannot notify a cancelled or retired owner: ${change}`, async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({
      allowed: true,
      beforeAuth: () => {
        started.resolve();
        return release.promise;
      },
    });
    try {
      const pending = f.compact();
      await started.promise;
      if (change === "abort") f.controller.abort(new Error("SECRET_ABORT_REASON"));
      if (change === "session") vi.spyOn(f.session, "getSessionId").mockReturnValue("SECRET_OTHER_SESSION");
      if (change === "reload") await f.mock.events.get("session_start")?.[0]({ reason: "reload" }, f.ctx);
      if (change === "shutdown") await f.mock.events.get("session_shutdown")?.[0]({ reason: "exit" }, f.ctx);
      release.resolve();
      assert.deepEqual(await pending, { cancel: true });
      assert.equal(f.requests.length, 0);
      assert.deepEqual(f.notifications, []);
    } finally {
      await f.cleanup();
    }
  });
}

test("throwing consent cancellation diagnostics cannot enable compaction", async () => {
  const f = await fixture({ confirm: async () => false });
  try {
    const notify = vi.spyOn((f.ctx as ExtensionContext).ui, "notify").mockImplementation(() => {
      throw new Error("HEADER_SECRET");
    });
    assert.deepEqual(await f.compact(), { cancel: true });
    assert.equal(f.authCalls(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(notify.mock.calls.length, 1);
    assert.equal(
      notify.mock.calls[0][0],
      "Compaction cancelled. [canonical_consent_denied] Canonical history was not authorized.",
    );
  } finally {
    await f.cleanup();
  }
});

test("confirmation timeout cancels and dismisses its owned dialog; late acceptance cannot dispatch", async () => {
  const answer = Promise.withResolvers<unknown>();
  const shown = Promise.withResolvers<void>();
  const f = await fixture({
    confirm: () => {
      shown.resolve();
      return answer.promise;
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = f.compact();
    await shown.promise;
    await vi.advanceTimersByTimeAsync(300000);
    assert.deepEqual(await pending, { cancel: true });
    assert.equal(f.dialogSignals[0].aborted, true);
    answer.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(f.authCalls(), 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.notifications, [
      {
        message: "Compaction cancelled. [canonical_consent_denied] Canonical history was not authorized.",
        level: "warning",
      },
    ]);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});
