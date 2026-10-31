import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCheckpointDetails, fallbackSummary, parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import type { JsonObject } from "../src/protocol.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";
import { withoutDiagnosticSummaries } from "./diagnostic-assertions.js";
import { createMockContext } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://model-destination.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const destination = "https://resolved-destination.test/backend-api/codex";
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.x`;
const PRIVATE = "PRIVATE_CANARY";
const ARMING = "HISTORIC_ARMING_CANARY";
const OMITTED = "OMITTED_CANARY";
const NATIVE_ERROR =
  "https://USER_CANARY:PASS_CANARY@failure.test/?token=TOKEN_CANARY Authorization: Bearer HEADER_CANARY";

function sse(compact: boolean): Response {
  const item = compact
    ? { type: "compaction", encrypted_content: "opaque" }
    : {
        type: "message",
        id: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      };
  const events = compact
    ? [{ type: "response.output_item.done", item }]
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
    [...events, { type: "response.completed", response: { status: "completed", output: [item] } }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function fixture(
  phase: "context" | "context_with_system",
  first: boolean,
  policy: "once" | "persistent" | "deny" | "decline" | "native" | "fallback" | "manual-failure",
  confirm?: () => Promise<boolean>,
) {
  const directory = mkdtempSync(join(tmpdir(), "codex-private-sdk-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live HTTP"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("Unexpected live WebSocket");
  });
  const requests: Array<{ url: string; payload: JsonObject; headers: Headers }> = [];
  let remoteFailed = false;
  let forceRemoteFailure = false;
  let menuClosed = false;
  let holdOrdinary: (() => void) | undefined;
  let ordinaryCancellations = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const payload = JSON.parse(
      typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8"),
    ) as JsonObject;
    requests.push({ url: String(url), payload, headers: new Headers(init?.headers) });
    const compact = payload.input.some((item: JsonObject) => item.type === "compaction_trigger");
    if (compact && (forceRemoteFailure || policy === "fallback" || policy === "manual-failure")) {
      if (policy === "manual-failure") assert.equal(menuClosed, true, "manual menu closes before remote dispatch");
      remoteFailed = true;
      return new Response('{"error":{"message":"Offline failure"}}', { status: 400 });
    }
    if (!compact && holdOrdinary) {
      const started = holdOrdinary;
      holdOrdinary = undefined;
      return new Response(
        new ReadableStream({
          start() {
            started();
          },
          cancel() {
            ordinaryCancellations++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (remoteFailed && policy === "manual-failure") {
      assert.equal(menuClosed, true, "native summarization also runs after menu close");
      return new Response(JSON.stringify({ error: { message: NATIVE_ERROR } }), { status: 400 });
    }
    return sse(compact);
  };
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(directory, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const actual = openaiCodexProvider();
    let authResolutions = 0;
    const provider: Provider = {
      ...actual,
      getModels: () => [model],
      auth: {
        apiKey: {
          name: "Offline",
          resolve: async () => {
            authResolutions += 1;
            return { auth: { apiKey, baseUrl: destination, headers: { "X-Auth-Canary": "AUTH_CANARY" } } };
          },
        },
      },
      stream: (m, c, o) => actual.stream(m, c, { ...o, transport: "sse", fetch: o?.fetch ?? fetch }),
      streamSimple: (m, c, o) => actual.streamSimple(m, c, { ...o, transport: "sse", fetch: o?.fetch ?? fetch }),
    };
    runtime.registerNativeProvider(provider);
    // A different provider using the same offline serializer is intentionally
    // unsupported by the extension, but remains usable by Pi native compaction.
    const unsupportedModel = { ...model, provider: "offline-other" };
    runtime.registerNativeProvider({ ...provider, id: unsupportedModel.provider, getModels: () => [unsupportedModel] });
    const compactSettings = createCodexCompactSettingsRuntime(join(directory, "pi-codex-compact.json"));
    if (policy === "persistent" || policy === "fallback" || policy === "manual-failure")
      await compactSettings.update({ allowCanonicalHistory: true, maxRetries: 0 });
    if (policy === "native") await compactSettings.update({ enabled: false });
    const manager = SessionManager.inMemory(directory);
    manager.appendMessage({ role: "user", content: `${PRIVATE} ${"Older conversation. ".repeat(100)}`, timestamp: 1 });
    manager.appendCustomMessageEntry("workflow-arming", ARMING, false, {});
    const omittedId = manager.appendMessage({ role: "user", content: OMITTED, timestamp: 2 });
    manager.appendContextEdit(omittedId, null);
    let filterCalls = 0;
    // Public payload-handler parity fixture: matches gpt-fast's priority return
    // contract, not an import of another extension's source or settings schema.
    const filterAndPriority = (pi: ExtensionAPI) => {
      pi.on(phase, (event) => {
        filterCalls += 1;
        return {
          messages: event.messages.filter(
            (message) => ![PRIVATE, ARMING].some((canary) => JSON.stringify(message).includes(canary)),
          ),
        };
      });
      pi.on("before_provider_request", (event) => ({ ...(event.payload as JsonObject), service_tier: "priority" }));
    };
    const compact = createCodexCompactExtension({ settingsRuntime: compactSettings, fetch });
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ["read"],
      compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 6 },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: ["PUBLIC_GUIDANCE_CANARY"],
      extensionFactories: first ? [compact, filterAndPriority] : [filterAndPriority, compact],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
    }));
    let confirmations = 0;
    const mock = createMockContext({
      mode: "tui",
      select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Compact now")),
      confirm: async () => {
        confirmations += 1;
        return confirm ? confirm() : policy === "once";
      },
    });
    const ui = (mock.ctx as ExtensionContext).ui;
    const custom = ui.custom;
    ui.custom = async (...args) => {
      const result = await custom(...args);
      menuClosed = true;
      return result;
    };
    await session.bindExtensions(
      policy === "once" || policy === "decline" || policy === "manual-failure" ? { mode: "tui", uiContext: ui } : {},
    );
    return {
      session,
      manager,
      requests,
      compactSettings,
      settingsManager,
      ui,
      unsupportedModel,
      failRemote: () => {
        forceRemoteFailure = true;
      },
      notifications: mock.notifications,
      menuClosed: () => menuClosed,
      holdNextOrdinary: () => {
        const started = Promise.withResolvers<void>();
        holdOrdinary = started.resolve;
        return started.promise;
      },
      ordinaryCancellations: () => ordinaryCancellations,
      filterCalls: () => filterCalls,
      confirmations: () => confirmations,
      authResolutions: () => authResolutions,
      cleanup: () => {
        session?.dispose();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

for (const phase of ["context", "context_with_system"] as const) {
  for (const first of [true, false]) {
    test(`SDK ordinary/consented canonical parity: ${phase}, compactor ${first ? "first" : "last"}`, async () => {
      const f = await fixture(phase, first, "persistent");
      try {
        await f.session.prompt("Public task");
        const normal = f.requests.at(-1);
        assert.ok(normal);
        assert.doesNotMatch(JSON.stringify(normal.payload), /PRIVATE_CANARY|HISTORIC_ARMING_CANARY|OMITTED_CANARY/);
        assert.equal(normal.payload.service_tier, "priority");
        const calls = f.filterCalls();
        const result = await f.session.compact();
        assert.equal(f.filterCalls(), calls, "compaction does not invoke ordinary request filters");
        const remote = f.requests.at(-1);
        assert.ok(remote);
        assert.match(JSON.stringify(remote.payload), /PRIVATE_CANARY/);
        assert.match(JSON.stringify(remote.payload), /HISTORIC_ARMING_CANARY/);
        assert.doesNotMatch(JSON.stringify(remote.payload), /OMITTED_CANARY/);
        assert.deepEqual(remote.payload.tools, normal.payload.tools);
        assert.deepEqual(remote.payload.instructions, normal.payload.instructions);
        assert.match(String(remote.payload.instructions), /PUBLIC_GUIDANCE_CANARY/);
        assert.equal(
          remote.payload.service_tier,
          undefined,
          "remote calls do not dispatch before_provider_request handlers",
        );
        assert.equal(normal.url, `${destination}/responses`);
        assert.equal(remote.url, normal.url);
        for (const request of f.requests) assert.equal(request.headers.get("Authorization"), `Bearer ${apiKey}`);
        const details = parseCheckpointDetails(result.details);
        assert.ok(details);
        assert.match(JSON.stringify(details.replacementHistory), /PRIVATE_CANARY/);
        assert.match(JSON.stringify(details.replacementHistory), /HISTORIC_ARMING_CANARY/);
        assert.doesNotMatch(JSON.stringify(details), /AUTH_CANARY|resolved-destination|OMITTED_CANARY/);
        await f.session.reload();
        await f.session.prompt("Replay task");
        const replay = f.requests.at(-1)?.payload;
        assert.match(JSON.stringify(replay), /PRIVATE_CANARY/);
        assert.match(JSON.stringify(replay), /HISTORIC_ARMING_CANARY/);
        assert.equal(replay?.service_tier, "priority", "payload handlers compose with opaque replay in both orders");
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const policy of ["deny", "decline", "once", "native", "fallback"] as const) {
  test(`SDK actual SSE privacy boundary: ${policy}`, async () => {
    const f = await fixture("context", false, policy);
    try {
      await f.session.prompt("Public task");
      const calls = f.filterCalls();
      const requests = f.requests.length;
      const authResolutions = f.authResolutions();
      if (policy === "deny" || policy === "decline") {
        await assert.rejects(f.session.compact(), /cancel/i);
        assert.equal(f.requests.length, requests, "neither remote nor native summaries can dispatch");
        assert.equal(f.authResolutions(), authResolutions, "unconsented compaction cannot resolve credentials");
        assert.equal(
          f.manager.getBranch().some((entry) => entry.type === "compaction"),
          false,
        );
      } else {
        const result = await f.session.compact();
        assert.equal(f.requests.length, requests + (policy === "fallback" ? 2 : 1));
        assert.match(JSON.stringify(f.requests.at(-1)?.payload), /PRIVATE_CANARY/);
        assert.match(JSON.stringify(f.requests.at(-1)?.payload), /HISTORIC_ARMING_CANARY/);
        assert.doesNotMatch(JSON.stringify(f.requests.at(-1)?.payload), /OMITTED_CANARY/);
        assert.equal(!!parseCheckpointDetails(result.details), policy === "once");
        if (policy === "once") {
          assert.equal(f.confirmations(), 1);
          assert.equal(f.compactSettings.get().settings.allowCanonicalHistory, false);
          assert.equal(f.compactSettings.get().kind, "missing");
        }
      }
      assert.equal(f.filterCalls(), calls, "native and remote compaction bypass ordinary filters");
    } finally {
      f.cleanup();
    }
  });
}

for (const notifyOnFallback of [true, false]) {
  test(`SDK remote failure preserves an effective opaque checkpoint (fallback notices ${notifyOnFallback})`, async () => {
    const f = await fixture("context", false, "persistent");
    try {
      await f.session.prompt("Public task");
      const first = await f.session.compact();
      assert.ok(parseCheckpointDetails(first.details));
      await f.session.prompt("Continue after the remote checkpoint.");
      await f.compactSettings.update({ notifyOnFallback });
      const before = f.manager.getBranch();
      const requests = f.requests.length;
      f.failRemote();
      await assert.rejects(f.session.compact(), /cancel/i);
      assert.equal(f.requests.length, requests + 1, "remote failure must not dispatch native summarization");
      assert.deepEqual(f.manager.getBranch(), before, "cancellation preserves the effective checkpoint and branch");
      const latest = before.filter((entry) => entry.type === "compaction").at(-1);
      assert.ok(latest?.type === "compaction" && parseCheckpointDetails(latest.details));
      await f.session.prompt("Continue after the cancelled compaction.");
      assert.match(JSON.stringify(f.requests.at(-1)?.payload), /encrypted_content/);
      assert.match(JSON.stringify(f.requests.at(-1)?.payload), /PRIVATE_CANARY/);
    } finally {
      f.cleanup();
    }
  });
}

for (const boundary of ["opaque", "malformed", "missing details", "none", "superseded", "disabled"] as const) {
  test(`SDK unsupported-provider manual compaction: ${boundary}`, async () => {
    const f = await fixture("context", false, "persistent");
    try {
      await f.session.prompt("Public task");
      const firstKept = f.manager.getBranch().find((entry) => entry.type === "message")?.id;
      assert.ok(firstKept);
      if (boundary !== "none") {
        const details = createCheckpointDetails({
          modelId: model.id,
          checkpointId: "sdk-safety-checkpoint",
          replacementHistory: [{ type: "compaction", encrypted_content: "older-opaque" }],
          keptMessages: [],
        });
        f.manager.appendCompaction(
          fallbackSummary(details.checkpointId),
          firstKept,
          100,
          boundary === "malformed"
            ? { ...details, replacementHistory: [] }
            : boundary === "missing details"
              ? undefined
              : details,
        );
        f.manager.appendMessage({ role: "user", content: "Retained recent task", timestamp: 3 });
        if (boundary === "superseded") {
          // The historical opaque entry is retained in raw history, not active.
          f.manager.appendCompaction("Readable native summary", firstKept, 100);
        }
      }
      if (boundary === "disabled") await f.compactSettings.update({ enabled: false });
      else await f.compactSettings.update({ allowCanonicalHistory: false });
      assert.equal(await f.session.setModel(f.unsupportedModel), undefined);
      const before = f.manager.getEntries();
      const leaf = f.manager.getLeafId();
      const requests = f.requests.length;
      const auth = f.authResolutions();
      if (boundary === "opaque" || boundary === "malformed" || boundary === "missing details") {
        // Retry through the installed SDK's real manual compaction entry point.
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(f.session.compact(), /cancel/i);
          assert.equal(f.requests.length, requests, "neither native nor remote provider dispatch");
          assert.equal(f.authResolutions(), auth, "cancel before credential resolution");
          assert.deepEqual(f.manager.getEntries(), before, "no append or checkpoint supersession");
          assert.equal(f.manager.getLeafId(), leaf);
        }
      } else {
        const result = await f.session.compact();
        assert.equal(parseCheckpointDetails(result.details), undefined);
        // Pi may summarize both history and a split-turn prefix.
        assert.equal(
          f.requests.length,
          requests + (boundary === "none" ? 1 : 2),
          "native compaction remains available",
        );
        assert.equal(f.manager.getEntries().length, before.length + 1);
        assert.notEqual(f.manager.getLeafId(), leaf);
        for (const request of f.requests.slice(requests)) {
          assert.equal(
            request.payload.input.some((item: JsonObject) => item.type === "compaction_trigger"),
            false,
          );
        }
      }
    } finally {
      f.cleanup();
    }
  });
}

test("SDK rejects malformed deep opaque details before auth, native dispatch, or append", async () => {
  const f = await fixture("context", false, "persistent");
  try {
    await f.session.prompt("Public task");
    await f.session.bindExtensions({ mode: "tui", uiContext: f.ui });
    const keptId = f.manager.getBranch().find((entry) => entry.type === "message")?.id;
    assert.ok(keptId);
    const details = createCheckpointDetails({
      modelId: model.id,
      checkpointId: "sdk-deep-checkpoint",
      replacementHistory: [{ type: "compaction", encrypted_content: "offline-opaque" }],
      keptMessages: [],
    });
    // This is valid JSON, but JSON.stringify/structuredClone cannot process its
    // depth. In-memory SDK entries let us exercise the real swallowed-hook seam.
    const nested: unknown = JSON.parse(`${"[".repeat(20_000)}0${"]".repeat(20_000)}`);
    f.manager.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, {
      ...details,
      replacementHistory: [{ role: "user", content: nested }, ...details.replacementHistory],
    });
    f.manager.appendMessage({ role: "user", content: "Recent offline request. ".repeat(100), timestamp: 3 });
    const before = f.manager.getEntries();
    const leaf = f.manager.getLeafId();
    const auth = f.authResolutions();
    const requests = f.requests.length;
    f.notifications.length = 0;
    await assert.rejects(f.session.compact(), /^Error: Compaction cancelled$/);
    assert.equal(f.authResolutions(), auth, "malformed opaque gate must precede credentials");
    assert.equal(f.requests.length, requests, "neither remote nor native summaries may dispatch");
    assert.deepEqual(f.manager.getEntries(), before, "no checkpoint append or supersession");
    assert.equal(f.manager.getLeafId(), leaf);
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /\[checkpoint_malformed\]/);
  } finally {
    f.cleanup();
  }
});

for (const route of ["unsupported", "remote failure"] as const) {
  test(`SDK throwing cancellation notification cannot enable native compaction: ${route}`, async () => {
    const f = await fixture("context", false, "persistent");
    try {
      await f.session.prompt("Public task");
      const first = await f.session.compact();
      assert.ok(parseCheckpointDetails(first.details));
      await f.session.prompt("Continue after the opaque checkpoint.");
      if (route === "unsupported") await f.session.setModel(f.unsupportedModel);
      else f.failRemote();
      const notify = vi.spyOn(f.ui, "notify").mockImplementation(() => {
        throw new Error("Offline UI unavailable");
      });
      await f.session.bindExtensions({ mode: "tui", uiContext: f.ui });
      const before = f.manager.getEntries();
      const requests = f.requests.length;
      const auth = f.authResolutions();
      await assert.rejects(f.session.compact(), /cancel/i);
      assert.equal(notify.mock.calls.length, 1);
      assert.equal(f.requests.length, requests + (route === "unsupported" ? 0 : 1));
      if (route === "unsupported") assert.equal(f.authResolutions(), auth);
      assert.deepEqual(f.manager.getEntries(), before, "notification failure cannot supersede the checkpoint");
    } finally {
      f.cleanup();
    }
  });
}

for (const phase of ["start", "final"] as const) {
  test(`SDK throwing ${phase} progress status cannot enable native compaction`, async () => {
    const f = await fixture("context", false, "persistent");
    try {
      await f.session.prompt("Public task");
      const first = await f.session.compact();
      assert.ok(parseCheckpointDetails(first.details));
      await f.session.prompt("Continue after the opaque checkpoint.");
      f.failRemote();
      const status = vi.spyOn(f.ui, "setStatus").mockImplementation((_key, value) => {
        if ((phase === "start") === (value !== undefined)) throw new Error("Offline status unavailable");
      });
      await f.session.bindExtensions({ mode: "tui", uiContext: f.ui });
      const before = f.manager.getEntries();
      const requests = f.requests.length;
      await assert.rejects(f.session.compact(), /cancel/i);
      assert.deepEqual(
        status.mock.calls.map(([key, value]) => [key, value]),
        [
          ["codex-compact", "Codex remote compaction…"],
          ["codex-compact", undefined],
        ],
      );
      assert.equal(f.requests.length, requests + 1, "only the failing remote request, never a native summary");
      assert.deepEqual(f.manager.getEntries(), before, "progress UI failure cannot supersede the checkpoint");
    } finally {
      f.cleanup();
    }
  });
}

test("SDK threshold compaction cancels on an incompatible opaque provider without blocking the ordinary request", async () => {
  const f = await fixture("context", false, "persistent");
  try {
    await f.session.prompt("Public task");
    const first = await f.session.compact();
    assert.ok(parseCheckpointDetails(first.details));
    await f.session.setModel(f.unsupportedModel);
    await f.session.prompt("Recent task after the checkpoint. ".repeat(100));
    f.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 99_999, keepRecentTokens: 6 } });
    const before = f.manager.getEntries().filter((entry) => entry.type === "compaction");
    const attempts: string[] = [];
    const unsubscribe = f.session.subscribe((event) => {
      if (event.type === "compaction_start") attempts.push(event.reason);
    });
    const requests = f.requests.length;
    try {
      await f.session.prompt("Continue with an ordinary unsupported-provider request.");
    } finally {
      unsubscribe();
    }
    assert.ok(attempts.includes("threshold"), "exercise Pi's automatic entrypoint, not a fabricated hook reason");
    assert.equal(f.requests.length, requests + 1, "only the ordinary request dispatches, no native summary");
    assert.deepEqual(
      f.manager.getEntries().filter((entry) => entry.type === "compaction"),
      before,
    );
    assert.match(JSON.stringify(f.requests.at(-1)?.payload), /stores the older history opaquely/);
    assert.equal(
      f.requests
        .at(-1)
        ?.payload.input.some((item: JsonObject) => item.type === "compaction" || item.type === "compaction_trigger"),
      false,
    );
  } finally {
    f.cleanup();
  }
});

for (const delivery of ["current", "after-navigation"] as const) {
  test(`SDK manual menu remote/native failure: credential-free ${delivery} delivery`, async () => {
    const f = await fixture("context", false, "manual-failure");
    try {
      await f.session.prompt("Public task"); // Actual Codex serializer + offline SSE establish live tool evidence.
      const calls = f.filterCalls();
      const requests = f.requests.length;
      const targetId = f.manager.getBranch().find((entry) => entry.type === "message")?.id;
      assert.ok(targetId);
      f.notifications.length = 0;
      const compact = f.session.compact.bind(f.session);
      // Exercise the SDK's real fire-and-forget ctx.compact callback. Only delay
      // rejection delivery to cover an already-failed operation outliving navigation.
      const dispatched = vi.spyOn(f.session, "compact").mockImplementation(async (instructions) => {
        try {
          return await compact(instructions);
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(NATIVE_ERROR), "core native error really echoes all credential canaries");
          if (delivery === "after-navigation") {
            const result = await f.session.navigateTree(targetId);
            assert.equal(result.cancelled, false);
          }
          throw error;
        }
      });
      await f.session.prompt("/codex-compact");
      assert.equal(f.menuClosed(), true);
      assert.equal(dispatched.mock.calls.length, 1);
      await assert.rejects(dispatched.mock.results[0].value, /USER_CANARY/);
      assert.equal(f.requests.length, requests + 2, "remote failure attempts native summarization, not fake success");
      for (const request of f.requests.slice(requests)) {
        assert.match(JSON.stringify(request.payload), /PRIVATE_CANARY/);
        assert.match(JSON.stringify(request.payload), /HISTORIC_ARMING_CANARY/);
        assert.doesNotMatch(JSON.stringify(request.payload), /OMITTED_CANARY/);
      }
      assert.equal(f.filterCalls(), calls, "authorized canonical/native semantics remain unchanged");
      assert.equal(
        f.manager.getEntries().some((entry) => entry.type === "compaction"),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(f.notifications),
        /USER_CANARY|PASS_CANARY|TOKEN_CANARY|HEADER_CANARY|failure\.test|Authorization|Bearer/,
      );
      assert.deepEqual(withoutDiagnosticSummaries(f.notifications), [
        {
          message: "Codex remote compaction failed; using Pi compaction. [remote_http_error; HTTP 400]",
          level: "warning",
        },
        ...(delivery === "current" ? [{ message: "Compaction failed.", level: "error" }] : []),
      ]);
    } finally {
      f.cleanup();
    }
  });
}

test("SDK Compact now during streaming reports a genuine native failure after aborting the old agent turn", async () => {
  const f = await fixture("context", false, "manual-failure");
  try {
    await f.session.prompt("Public task");
    const started = f.holdNextOrdinary();
    const ordinary = f.session.prompt("Keep this ordinary offline request open.");
    await started;
    const oldAgentSignal = f.session.agent.signal;
    assert.ok(oldAgentSignal);
    assert.equal(f.session.isStreaming, true);
    assert.equal(oldAgentSignal.aborted, false);
    const requests = f.requests.length;
    f.notifications.length = 0;
    const compact = f.session.compact.bind(f.session);
    const dispatched = vi.spyOn(f.session, "compact").mockImplementation(async (instructions) => {
      // Observe, but do not replace, SDK abort -> hook -> native summarizer.
      try {
        return await compact(instructions);
      } catch (error) {
        assert.equal(oldAgentSignal.aborted, true, "native compact intentionally aborts the active agent turn");
        assert.ok(error instanceof Error && error.message.includes(NATIVE_ERROR));
        throw error;
      }
    });
    await f.session.prompt("/codex-compact");
    assert.equal(f.menuClosed(), true);
    assert.equal(dispatched.mock.calls.length, 1);
    await assert.rejects(dispatched.mock.results[0].value, /USER_CANARY/);
    await ordinary;
    assert.equal(f.ordinaryCancellations(), 1, "the real provider cancels the interrupted ordinary response body");
    assert.equal(f.requests.length, requests + 2, "both real remote and native summarizers run after abort");
    assert.equal(
      f.manager.getEntries().some((entry) => entry.type === "compaction"),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(f.notifications),
      /USER_CANARY|PASS_CANARY|TOKEN_CANARY|HEADER_CANARY|failure\.test|Authorization|Bearer/,
    );
    assert.deepEqual(withoutDiagnosticSummaries(f.notifications), [
      {
        message: "Codex remote compaction failed; using Pi compaction. [remote_http_error; HTTP 400]",
        level: "warning",
      },
      { message: "Compaction failed.", level: "error" },
    ]);
  } finally {
    f.cleanup();
  }
});

for (const decision of ["denial", "abort", "replacement"] as const) {
  for (const throwsUI of [false, true]) {
    test(`SDK Compact now menu preserves ${decision} cancellation (throwing UI ${throwsUI})`, async () => {
      const answer = Promise.withResolvers<boolean>();
      const shown = Promise.withResolvers<void>();
      const f = await fixture(
        "context",
        false,
        decision === "abort" ? "once" : "decline",
        decision === "abort"
          ? () => {
              shown.resolve();
              return answer.promise;
            }
          : undefined,
      );
      try {
        await f.session.prompt("Public task");
        const before = f.manager.getEntries();
        const requests = f.requests.length;
        const auth = f.authResolutions();
        f.notifications.length = 0;
        const notify = vi.spyOn(f.ui, "notify");
        if (throwsUI)
          notify.mockImplementation(() => {
            throw new Error(NATIVE_ERROR);
          });
        await f.session.bindExtensions({ mode: "tui", uiContext: f.ui });
        const compact = f.session.compact.bind(f.session);
        const dispatched = vi.spyOn(f.session, "compact").mockImplementation(async (instructions) => {
          try {
            return await compact(instructions);
          } catch (error) {
            if (decision === "replacement") {
              await f.session.reload();
              notify.mockClear();
              f.notifications.length = 0;
            }
            throw error;
          }
        });
        await f.session.prompt("/codex-compact");
        assert.equal(f.menuClosed(), true);
        assert.equal(dispatched.mock.calls.length, 1);
        const cancelled = assert.rejects(dispatched.mock.results[0].value, /^Error: Compaction cancelled$/);
        if (decision === "abort") {
          await shown.promise;
          f.session.abortCompaction();
          answer.resolve(true);
        }
        await cancelled;
        assert.equal(f.authResolutions(), auth);
        assert.equal(f.requests.length, requests, "menu cancellation dispatches no remote/native summary");
        assert.deepEqual(f.manager.getEntries(), before);
        assert.deepEqual(
          notify.mock.calls.map(([message, level]) => ({ message, level })),
          decision === "denial"
            ? [
                {
                  message: "Compaction cancelled. [canonical_consent_denied] Canonical history was not authorized.",
                  level: "warning",
                },
              ]
            : [],
        );
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const change of ["abort", "branch", "reload"] as const) {
  test(`SDK awaiting consent ${change}: no credential resolution, remote dispatch, or native fallback`, async () => {
    const answer = Promise.withResolvers<boolean>();
    const shown = Promise.withResolvers<void>();
    const f = await fixture("context", false, "once", () => {
      shown.resolve();
      return answer.promise;
    });
    try {
      await f.session.prompt("Public task");
      const requests = f.requests.length;
      const authResolutions = f.authResolutions();
      const pending = f.session.compact();
      // Observe rejection immediately: abort/reload can finish before we answer.
      const cancelled = assert.rejects(pending, /cancel|abort/i);
      await shown.promise;
      if (change === "abort") f.session.abortCompaction();
      if (change === "branch") f.manager.appendMessage({ role: "user", content: "Different branch", timestamp: 3 });
      if (change === "reload") await f.session.reload();
      answer.resolve(true);
      await cancelled;
      assert.equal(f.authResolutions(), authResolutions);
      assert.equal(f.requests.length, requests);
      assert.equal(f.compactSettings.get().settings.allowCanonicalHistory, false);
      assert.equal(
        f.manager.getBranch().some((entry) => entry.type === "compaction"),
        false,
      );
    } finally {
      f.cleanup();
    }
  });
}
