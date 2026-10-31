import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { getCurrentSystemPrompt, type Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type ExtensionCommandContext,
  InteractiveMode,
  initTheme,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  projectCheckpointContext,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import type { JsonObject } from "../src/protocol.js";
import { createRecoveryCommand } from "../src/recovery-command.js";
import { splitRecoveryContext } from "../src/recovery-snapshot.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { withoutDiagnosticSummaries } from "./diagnostic-assertions.js";
import { createMockContext, createMockPi } from "./support.js";

// Small command-boundary harness: all state and auth are synthetic; transport is
// forbidden. Real provider serialization/reopen qualification lives in recovery-sdk.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-owner-"));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "Synthetic source", timestamp: 1 });
  const model = {
    id: "issuing-A",
    name: "Synthetic",
    provider: "openai-codex",
    api: "openai-codex-responses" as const,
    baseUrl: "https://offline.test",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  const provider = { stream() {}, streamSimple() {}, auth: { apiKey: { resolve() {} } } };
  let registered = provider;
  let eligible = true;
  let timeout = 60000;
  let confirm = async () => true;
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  let capturedSignal: AbortSignal | undefined;
  let authCount = 0;
  let input: ((data: string) => unknown) | undefined;
  let widget: { dispose(): void } | undefined;
  const widgets = new Map<string, unknown>();
  const mock = createMockContext({
    mode: "tui",
    model,
    sessionManager: manager,
    confirm: () => confirm(),
    modelRegistry: { getProvider: () => registered, getApiKeyAndHeaders() {} },
  });
  const ctx = mock.ctx as ExtensionCommandContext;
  Object.assign(ctx.ui, {
    onTerminalInput(handler: typeof input) {
      input = handler;
      return () => {
        if (input === handler) input = undefined;
      };
    },
    setWidget(key: string, factory: (() => { dispose(): void }) | undefined) {
      const old = widgets.get(key) as { dispose(): void } | undefined;
      old?.dispose();
      widgets.delete(key);
      if (factory) {
        widget = factory();
        widgets.set(key, widget);
      }
    },
  });
  const prior = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: [{ type: "compaction", encrypted_content: "synthetic" }],
    keptMessages: [],
  });
  const runtime: CodexCompactSettingsRuntime = {
    get: () => ({
      kind: "missing",
      path: join(directory, "synthetic-settings"),
      document: {},
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, requestTimeoutMs: timeout },
    }),
    reload: async () => runtime.get(),
    update: async () => {
      throw new Error("No writes");
    },
    flush: async () => {},
  };
  const pi = createMockPi().pi;
  Object.assign(pi, { getSettings: () => ({ compaction: { keepRecentTokens: 1 } }) });
  const recovery = createRecoveryCommand(pi, runtime, {
    project: () => ({
      prior,
      transcript: [],
      messages: [
        { role: "system", content: "Synthetic system", timestamp: 1 },
        { role: "user", content: checkpointMarker(prior.checkpointId), timestamp: 1 },
        { role: "user", content: "Meaningful prefix".repeat(100), timestamp: 1 },
        { role: "user", content: "Unsent tail", timestamp: 1 },
      ],
    }),
    matches: () => eligible,
    tools: () => [],
    payloadValidator: () => undefined,
    authenticate: async (_ctx, _model, signal) => {
      authCount++;
      capturedSignal = signal;
      started.resolve();
      await late.promise;
      return { ok: false, error: "missing" };
    },
    fetch: async () => {
      assert.fail("No transport permitted");
    },
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No live HTTP"));
  const files = readdirSync(directory);
  return {
    ctx,
    recovery,
    provider,
    directory,
    started,
    late,
    widgets,
    notifications: mock.notifications,
    offer: () => recovery.run(ctx, new AbortController().signal),
    run: async () => {
      const start = mock.notifications.length;
      await recovery.run(ctx, new AbortController().signal);
      const notice = mock.notifications[start];
      const nonce = notice?.message.match(/confirm-recovery ([a-f0-9-]{36})/)?.[1];
      if (!nonce) return;
      // Existing active-work assertions measure only post-offer notifications.
      mock.notifications.splice(start, 1);
      if (await confirm()) await recovery.handle(`confirm-recovery ${nonce}`, ctx);
    },
    confirm: (fn: typeof confirm) => {
      confirm = fn;
    },
    replaceProvider: () => {
      registered = { ...provider };
    },
    mismatch: () => {
      eligible = false;
    },
    timeout: () => {
      timeout = 10;
    },
    input: (data: string) => input?.(data),
    dispose: () => {
      assert.ok(widget);
      widget.dispose();
    },
    authCount: () => authCount,
    signal: () => capturedSignal,
    assertNoExport: () => assert.deepEqual(readdirSync(directory), files),
    cleanup: () => {
      late.resolve();
      recovery.cancel();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Exercise the registered command and the extension's real shared matcher/tracker
// with an idle, accepted C/E witness. Only injected synthetic transport is allowed.
async function witnessedPromptFixture(phase: "stable" | "offer" | "auth" | "body" | "staging") {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-prompt-owner-"));
  const canonical = "Synthetic canonical recovery instructions";
  const effective = "Synthetic request-local recovery instructions";
  let livePrompt = effective;
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "system", content: canonical, timestamp: 1 });
  manager.appendMessage({ role: "user", content: "Synthetic older task", timestamp: 2 });
  const kept = { role: "user" as const, content: "Meaningful canonical prefix ".repeat(100), timestamp: 3 };
  const keptId = manager.appendMessage(kept);
  const model: Model<"openai-codex-responses"> = {
    id: "offline-recovery",
    name: "Offline recovery",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://offline.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  const prior = createCheckpointDetails({
    modelId: model.id,
    replacementHistory: [{ type: "compaction", encrypted_content: "synthetic-prior" }],
    keptMessages: [kept],
  });
  const checkpointId = manager.appendCompaction(fallbackSummary(prior.checkpointId), keptId, 100, prior);
  manager.appendMessage({ ...kept, timestamp: 4 });
  manager.appendMessage({ role: "user", content: "Unsent tail", timestamp: 5 });
  const checkpoint = manager.getBranch().find((entry) => entry.id === checkpointId);
  assert.ok(checkpoint?.type === "compaction" && checkpoint.systemMessage);
  const sourceFile = manager.getSessionFile();
  assert.ok(sourceFile);
  const sourceBytes = readFileSync(sourceFile);
  const branchIds = manager.getBranch().map((entry) => entry.id);
  const files = readdirSync(directory);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const payloads: JsonObject[] = [];
  let authCount = 0;
  const provider = openaiCodexProvider();
  const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64")}.x`;
  const mock = createMockContext({
    mode: "tui",
    model,
    cwd: directory,
    sessionManager: manager,
    getSystemPrompt: () => livePrompt,
    select: async (_title: string, options: string[]) => options.find((option) => option.includes("Recovery export")),
    modelRegistry: {
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => {
        authCount++;
        if (phase === "auth") {
          started.resolve();
          await release.promise;
        }
        return { ok: true, apiKey };
      },
    },
  });
  const ctx = mock.ctx as ExtensionCommandContext;
  const widgets = new Map<string, unknown>();
  Object.assign(ctx.ui, {
    onTerminalInput: () => () => {},
    setWidget(key: string, factory: (() => unknown) | undefined) {
      if (factory) widgets.set(key, factory());
      else widgets.delete(key);
    },
  });
  const runtime: CodexCompactSettingsRuntime = {
    get: () => ({
      kind: "missing",
      path: join(directory, "synthetic-settings"),
      document: {},
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, allowCanonicalHistory: false },
    }),
    reload: async () => runtime.get(),
    update: async () => assert.fail("No settings writes"),
    flush: async () => {},
  };
  const pi = createMockPi();
  Object.assign(pi.pi, { getSettings: () => ({ compaction: { keepRecentTokens: 1 } }) });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No live HTTP"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("No live WebSocket");
  });
  createCodexCompactExtension({
    settingsRuntime: runtime,
    fetch: async (_url, init) => {
      const body = init?.body;
      assert.ok(typeof body === "string" || body instanceof Uint8Array);
      payloads.push(JSON.parse(typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8")));
      if (phase === "body") {
        started.resolve();
        await release.promise;
      }
      const item = { type: "compaction", encrypted_content: "synthetic-new" };
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  })(pi.pi);
  // No live Goal or ordinary model call: these are the actual extension hooks
  // which prepare/accept the witness from a synthetic ordinary SDK callback.
  const transcript = manager.buildSessionContext().messages;
  const projection = projectCheckpointContext(transcript, prior, "full");
  assert.ok(projection, JSON.stringify(transcript));
  const split = splitRecoveryContext(
    projection.filter((message) => message.role !== "system"),
    prior.checkpointId,
    1,
  );
  assert.equal(split.prefix.length, 2);
  assert.equal(split.suffix.length, 1);
  await pi.events.get("context")?.[0]({ messages: transcript }, ctx);
  await pi.events.get("before_provider_request")?.[0]({ payload: { instructions: effective, tools: [] } }, ctx);
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
  const handler = pi.commands.get("codex-compact")?.handler;
  assert.ok(handler);
  initTheme("dark");
  await handler("", ctx);
  const offer = mock.notifications.at(-1)?.message ?? "";
  assert.match(offer, /^Recovery OFFER ONLY:/, "real shared matcher must accept the initial C/E witness");
  const nonce = offer.match(/confirm-recovery ([a-f0-9-]{36})/)?.[1];
  assert.ok(nonce);
  return {
    canonical,
    effective,
    started,
    release,
    payloads,
    notifications: mock.notifications,
    widgets,
    authCount: () => authCount,
    confirm: () => handler(`confirm-recovery ${nonce}`, ctx),
    clearEffective: () => {
      livePrompt = canonical;
    },
    changeCanonical: () => {
      assert.ok(checkpoint.systemMessage);
      checkpoint.systemMessage.content = effective;
      assert.equal(getCurrentSystemPrompt(manager.buildSessionContext().messages), effective);
      assert.deepEqual(
        manager.getBranch().map((entry) => entry.id),
        branchIds,
        "same IDs and in-place head edit",
      );
    },
    assertSourceUnchanged: () => assert.deepEqual(readFileSync(sourceFile), sourceBytes),
    assertUnchanged: () => {
      assert.deepEqual(readFileSync(sourceFile), sourceBytes, "original persisted source is read-only");
      assert.deepEqual(readdirSync(directory), files, "no export or staging artifact");
    },
    exports: () => readdirSync(directory).filter((file) => !files.includes(file) && file.endsWith(".jsonl")),
    cleanup: async () => {
      release.resolve();
      await pi.events.get("session_shutdown")?.[0]({ reason: "exit" }, ctx);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const phase of ["before publication", "after publication"] as const) {
  test(`recovery hard deadline across synchronous fsync: ${phase}`, async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const f = await witnessedPromptFixture("stable");
    const sync = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      sync(fd);
      if (++calls === (phase === "before publication" ? 1 : 2)) now = 300_001;
    });
    try {
      await f.confirm();
      assert.equal(f.payloads.length, 1);
      if (phase === "before publication") {
        assert.equal(f.exports().length, 0, "expired synchronous staging must not publish");
        assert.ok(f.notifications.some((entry) => entry.message.includes("[remote_timeout]")));
        f.assertUnchanged();
      } else {
        assert.equal(f.exports().length, 1, "already-published success stays visible");
        assert.match(f.notifications.at(-1)?.message ?? "", /Recovery exported to NEW session/);
        f.assertSourceUnchanged();
      }
    } finally {
      await f.cleanup();
    }
  });
}

test("idle recovery stable witnessed C/E exports once with canonical wire instructions", async () => {
  const f = await witnessedPromptFixture("stable");
  try {
    assert.equal(f.authCount(), 0, "offer is read-only");
    assert.equal(f.payloads.length, 0);
    await f.confirm();
    assert.equal(f.authCount(), 1);
    assert.equal(f.payloads.length, 1);
    assert.equal(f.payloads[0].instructions, f.canonical);
    assert.notEqual(f.payloads[0].instructions, f.effective);
    assert.equal(f.exports().length, 1);
    assert.match(f.notifications.at(-1)?.message ?? "", /Recovery exported to NEW session/);
    assert.equal(f.widgets.size, 0);
    await f.confirm();
    assert.equal(f.authCount(), 1, "nonce remains one-use");
    assert.equal(f.payloads.length, 1);
    assert.equal(f.exports().length, 1);
    f.assertSourceUnchanged();
  } finally {
    await f.cleanup();
  }
});

for (const phase of ["offer", "auth", "body", "staging"] as const) {
  for (const drift of ["effective-clear", "canonical-in-place"] as const) {
    test(`idle recovery witnessed C/E ${drift} during ${phase} retires the offer without publication`, async () => {
      const f = await witnessedPromptFixture(phase);
      try {
        const notices = f.notifications.length;
        const mutate = drift === "effective-clear" ? f.clearEffective : f.changeCanonical;
        if (phase === "offer") mutate();
        const command = f.confirm();
        if (phase !== "offer") {
          await f.started.promise;
          mutate();
          f.release.resolve();
        }
        await command;
        f.assertUnchanged();
        assert.equal(f.authCount(), phase === "offer" ? 0 : 1);
        assert.equal(f.payloads.length, phase === "body" || phase === "staging" ? 1 : 0);
        assert.equal(f.widgets.size, 0);
        if (phase === "offer") assert.match(f.notifications.at(-1)?.message ?? "", /no request was sent/);
        else assert.equal(f.notifications.length, notices, "no stale UI takeover or success notice");
      } finally {
        await f.cleanup();
      }
    });
  }
}

test("cold preflight loadout mismatch gives fixed warning, zero auth/transport/export", async () => {
  const f = fixture();
  try {
    f.mismatch();
    await f.run();
    assert.equal(f.authCount(), 0);
    f.assertNoExport();
    assert.match(JSON.stringify(f.notifications), /unavailable.*loadout_mismatch/);
    assert.equal(f.notifications.length, 1);
  } finally {
    f.cleanup();
  }
});

for (const drift of ["provider", "stream", "auth", "profile", "headless", "ui"] as const) {
  test(`confirmation ${drift} takeover rejects before auth`, async () => {
    const f = fixture();
    try {
      f.confirm(async () => {
        if (drift === "provider") f.replaceProvider();
        if (drift === "stream") f.provider.stream = () => {};
        if (drift === "auth") f.provider.auth.apiKey.resolve = () => {};
        if (drift === "profile") {
          assert.ok(f.ctx.model);
          Object.assign(f.ctx.model, { contextWindow: 42 });
        }
        if (drift === "headless") Object.assign(f.ctx, { mode: "print", hasUI: false });
        if (drift === "ui") Object.assign(f.ctx, { ui: { ...f.ctx.ui } });
        return true;
      });
      await f.run();
      assert.equal(f.authCount(), 0);
      f.assertNoExport();
      if (drift === "headless") assert.deepEqual(f.notifications, []);
      else assert.match(f.notifications.at(-1)?.message ?? "", /no request was sent/);
    } finally {
      f.cleanup();
    }
  });
}

for (const cancellation of ["dispose", "escape", "ctrl-c", "new-input", "headless", "ui"] as const) {
  test(`held auth ${cancellation} cannot publish or tear down unrelated UI`, async () => {
    const f = fixture();
    try {
      const command = f.run();
      await f.started.promise;
      assert.equal(f.input("\u001b[13;1:3u"), undefined);
      assert.equal(f.signal()?.aborted, false, "confirmation Enter release is not new input");
      const foreign = { dispose: vi.fn() };
      f.widgets.set("foreign", foreign);
      if (cancellation === "dispose") {
        f.dispose();
        assert.equal(f.signal()?.aborted, true);
      } else if (cancellation === "headless") Object.assign(f.ctx, { mode: "print", hasUI: false });
      else if (cancellation === "ui") Object.assign(f.ctx, { ui: { ...f.ctx.ui } });
      else {
        assert.equal(
          f.input(cancellation === "escape" ? "\u001b" : cancellation === "ctrl-c" ? "\u0003" : "new text"),
          undefined,
        );
        assert.equal(f.signal()?.aborted, true, "actual new input cancels synchronously without consumption");
      }
      f.late.resolve();
      await command;
      assert.equal(foreign.dispose.mock.calls.length, 0);
      assert.equal(f.widgets.get("foreign"), foreign);
      f.assertNoExport();
      assert.deepEqual(f.notifications, []);
    } finally {
      f.cleanup();
    }
  });
}

for (const userFirst of [false, true]) {
  test(`owned auth deadline (user cancellation first=${userFirst})`, async () => {
    const f = fixture();
    try {
      f.timeout();
      vi.useFakeTimers();
      const command = f.run();
      await f.started.promise;
      if (userFirst) f.input("\u001b");
      await vi.advanceTimersByTimeAsync(11);
      await command;
      assert.equal(f.signal()?.aborted, true);
      f.assertNoExport();
      if (userFirst) assert.deepEqual(f.notifications, []);
      else
        assert.deepEqual(withoutDiagnosticSummaries(f.notifications), [
          { message: "Recovery export failed; original unchanged. [remote_timeout]", level: "warning" },
        ]);
      const count = f.notifications.length;
      f.late.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(f.notifications.length, count);
    } finally {
      vi.useRealTimers();
      f.cleanup();
    }
  });
}

test("stale UI getter during direct disposal aborts without touching rebound owner", async () => {
  const f = fixture();
  try {
    const command = f.run();
    await f.started.promise;
    Object.defineProperty(f.ctx, "ui", {
      get() {
        throw new Error("Synthetic stale native context");
      },
    });
    assert.doesNotThrow(() => f.dispose());
    assert.equal(f.signal()?.aborted, true);
    await command;
    f.late.resolve();
    assert.deepEqual(f.notifications, []);
    f.assertNoExport();
  } finally {
    f.cleanup();
  }
});

for (const phase of ["active-dispose", "pending-cancel", "pending-expiry"] as const) {
  for (const dialog of ["custom", "confirm"] as const) {
    test(`real native overlapping ${dialog} dialog is untouched by recovery ${phase}`, async () => {
      const f = fixture();
      try {
        assert.ok(["1.0.4", "1.4.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
        initTheme("dark");
        const children: unknown[] = [];
        const editor = { getText: () => "Unrelated editor text", setText: vi.fn() };
        const host = Object.assign(Object.create(InteractiveMode.prototype), {
          editor,
          editorContainer: {
            clear: () => {
              children.length = 0;
            },
            addChild: (child: unknown) => children.push(child),
          },
          extensionWidgetsAbove: new Map(),
          extensionWidgetsBelow: new Map(),
          ui: { requestRender() {}, setFocus() {} },
          keybindings: {},
          renderWidgets() {},
          disposeActiveSelector() {},
          // 1.4.0 manages custom dialogs through a stack, rather than one editor slot.
          ...(VERSION === "1.4.0" ? { extensionDialogs: [], programStatus: { setBlocked: vi.fn() } } : {}),
        });
        const method = (name: string) =>
          Reflect.get(InteractiveMode.prototype, name) as (...args: unknown[]) => unknown;
        Object.assign(f.ctx.ui, { setWidget: (...args: unknown[]) => method("setExtensionWidget").apply(host, args) });
        if (phase === "pending-expiry") vi.useFakeTimers();
        const command = phase === "active-dispose" ? f.run() : f.offer();
        if (phase === "active-dispose") await f.started.promise;
        else {
          await command;
          assert.equal(f.authCount(), 0);
          assert.match(f.notifications.at(-1)?.message ?? "", /Recovery OFFER ONLY/);
          f.notifications.length = 0;
        }
        let closeModal: ((value: unknown) => void) | undefined;
        let modal = { render: () => ["Other extension modal"], invalidate() {}, dispose: vi.fn() };
        let result: Promise<unknown>;
        if (dialog === "custom") {
          result = method("showExtensionCustom").call(
            host,
            (_ui: unknown, _theme: unknown, _keys: unknown, done: (value: unknown) => void) => {
              closeModal = done;
              return modal;
            },
          ) as Promise<unknown>;
        } else {
          const foreignController = new AbortController();
          result = method("showExtensionConfirm").call(host, "Other extension", "Keep this selector", {
            signal: foreignController.signal,
          }) as Promise<unknown>;
          modal = children.at(-1) as typeof modal;
          vi.spyOn(modal, "dispose");
          closeModal = () => foreignController.abort();
        }
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(children.at(-1), modal);
        if (phase === "active-dispose") {
          method("clearExtensionWidgets").call(host); // Actual native reload/disposal behavior.
          assert.equal(f.signal()?.aborted, true);
        } else if (phase === "pending-cancel") f.recovery.cancel();
        else await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
        await command;
        f.late.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(children.at(-1), modal);
        assert.equal(modal.dispose.mock.calls.length, 0);
        assert.equal(editor.setText.mock.calls.length, 0, "no stale done restores/clobbers editor");
        assert.ok(closeModal);
        closeModal("foreign-completion");
        assert.equal(await result, dialog === "custom" ? "foreign-completion" : false);
        assert.equal(modal.dispose.mock.calls.length, 1);
        f.assertNoExport();
        assert.deepEqual(f.notifications, []);
      } finally {
        vi.useRealTimers();
        f.cleanup();
      }
    });
  }
}
