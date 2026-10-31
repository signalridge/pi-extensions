import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { test, vi } from "vitest";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import { createCodexCompactMenu, showCodexCompactMenu } from "../src/settings-menu.js";
import { createMockContext } from "./support.js";

function memoryRuntime(kind: CodexCompactSettingsState["kind"] = "missing") {
  let state: CodexCompactSettingsState = {
    kind,
    path: "/tmp/pi-codex-compact.json",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
    ...(kind === "invalid" ? { issue: "bad file" } : { document: {} }),
  };
  const patches: unknown[] = [];
  const runtime: CodexCompactSettingsRuntime = {
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async update(patch) {
      patches.push(patch);
      state = { ...state, kind: "loaded", settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    async flush() {},
  };
  return { runtime, patches };
}

test("root menu makes manual compaction primary and exposes its effective route", () => {
  const current = memoryRuntime();
  const menu = createCodexCompactMenu(current.runtime, {
    status: { model: "openai-codex/gpt-5.6", remoteCompatible: true },
  });
  assert.equal(menu.start, "main");
  const main = resolveMenuScreen(menu, "main", current.runtime.get());
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") assert.fail("Expected actions screen");
  assert.deepEqual(
    main.items.map((item) => item.label),
    ["Compact now", "Recovery export (new session)", "Settings", "Close"],
  );
  assert.match(main.lines?.join("\n") ?? "", /openai-codex\/gpt-5\.6/);
  assert.match(main.lines?.join("\n") ?? "", /Codex Remote V2/);
  const disabled = resolveMenuScreen(menu, "main", {
    ...current.runtime.get(),
    settings: { ...current.runtime.get().settings, enabled: false },
  });
  assert.equal(disabled.kind, "actions");
  if (disabled.kind !== "actions") assert.fail("Expected disabled actions screen");
  assert.match(disabled.lines?.join("\n") ?? "", /Pi native \(Remote V2 off\)/);
});

test("settings screen exposes bounded controls and invalid files remain repairable", () => {
  const current = memoryRuntime();
  const menu = createCodexCompactMenu(current.runtime);
  const screen = resolveMenuScreen(menu, "settings", current.runtime.get());
  assert.equal(screen.kind, "settings");
  if (screen.kind !== "settings") assert.fail("Expected settings screen");
  assert.deepEqual(
    screen.items.map((item) => [item.id, item.currentValue]),
    [
      ["enabled", "On"],
      ["allowCanonicalHistory", "Off"],
      ["requestTimeoutMs", "15 min"],
      ["stageTimeoutMs", "5 min"],
      ["maxRetries", "2"],
      ["replacementTokenBudget", "64K tokens"],
      ["notifyOnFallback", "On"],
    ],
  );

  const invalid = memoryRuntime("invalid");
  const invalidMenu = createCodexCompactMenu(invalid.runtime);
  const invalidMain = resolveMenuScreen(invalidMenu, "main", invalid.runtime.get());
  assert.equal(invalidMain.kind, "actions");
  if (invalidMain.kind !== "actions") assert.fail("Expected invalid root actions");
  assert.equal("to" in invalidMain.items[2] ? invalidMain.items[2].to : undefined, "invalid");
  const detail = resolveMenuScreen(invalidMenu, "invalid", invalid.runtime.get());
  assert.equal(detail.kind, "detail");
  if (detail.kind !== "detail") assert.fail("Expected invalid detail");
  assert.match(detail.lines.join("\n"), /will not be overwritten/);
});

test("manual action closes the menu and records one explicit request", async () => {
  const memory = memoryRuntime();
  let requests = 0;
  const menu = createCodexCompactMenu(memory.runtime, {
    onCompactRequested: () => {
      requests += 1;
    },
  });
  const result = await menu.actions["compact-now"]({
    ctx: createMockContext({ mode: "tui" }).ctx,
    state: memory.runtime.get(),
    signal: new AbortController().signal,
    itemId: "compact-now",
  });
  assert.deepEqual(result, { kind: "close" });
  assert.equal(requests, 1);
});

test("menu actions persist exact setting patches", async () => {
  const memory = memoryRuntime();
  const menu = createCodexCompactMenu(memory.runtime);
  const { ctx } = createMockContext({ mode: "tui" });
  const action = (value: string) => ({
    ctx,
    state: memory.runtime.get(),
    signal: new AbortController().signal,
    itemId: "setting",
    value,
  });
  await menu.actions["set-enabled"](action("Off"));
  await menu.actions["set-canonical"](action("On"));
  await menu.actions["set-timeout"](action("10 min"));
  await menu.actions["set-retries"](action("1"));
  await menu.actions["set-retention"](action("96K tokens"));
  await menu.actions["set-notify"](action("Off"));
  assert.deepEqual(memory.patches, [
    { enabled: false },
    { allowCanonicalHistory: true },
    { requestTimeoutMs: 600_000 },
    { maxRetries: 1 },
    { replacementTokenBudget: 96_000 },
    { notifyOnFallback: false },
  ]);
});

test("TUI manual action compacts once after close and reports fixed credential-free failure", async () => {
  const memory = memoryRuntime();
  let compactions = 0;
  let compactOptions: { onError?: (error: Error) => void } | undefined;
  const { ctx, notifications } = createMockContext({
    mode: "tui",
    model: { provider: "openai-codex", id: "gpt-5.6", api: "openai-codex-responses" },
    select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Compact now")),
    compact: (options: { onError?: (error: Error) => void }) => {
      compactions += 1;
      compactOptions = options;
    },
  });
  await showCodexCompactMenu(memory.runtime, ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assert.equal(compactions, 1);
  compactOptions?.onError?.(
    new Error("https://USER_CANARY:PASS_CANARY@failure.test/?token=TOKEN_CANARY Authorization: Bearer HEADER_CANARY"),
  );
  assert.equal(notifications.at(-1)?.message, "Compaction failed.");
  assert.equal(notifications.at(-1)?.level, "error");
});

test("stale menu ownership cannot trigger delayed manual compaction", async () => {
  const memory = memoryRuntime();
  let current = true;
  let compactions = 0;
  const { ctx } = createMockContext({
    mode: "tui",
    select: async (_title: string, options: string[]) => {
      current = false;
      return options.find((option) => option.startsWith("Compact now"));
    },
    compact: () => {
      compactions += 1;
    },
  });
  await showCodexCompactMenu(memory.runtime, ctx, {
    signal: new AbortController().signal,
    isCurrent: () => current,
  });
  assert.equal(compactions, 0);
});

for (const retirement of ["abort", "navigation"] as const) {
  test(`late manual error after menu close and ${retirement} cannot notify stale UI`, async () => {
    const memory = memoryRuntime();
    const controller = new AbortController();
    let current = true;
    let compactOptions: { onError?: (error: Error) => void } | undefined;
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Compact now")),
      compact: (options: { onError?: (error: Error) => void }) => {
        compactOptions = options;
      },
    });
    await showCodexCompactMenu(memory.runtime, ctx, {
      signal: controller.signal,
      isCurrent: () => current,
    });
    assert.ok(compactOptions?.onError, "manual action has closed and dispatched compaction");
    if (retirement === "abort") controller.abort();
    else current = false;
    compactOptions.onError(new Error("https://USER_CANARY:PASS_CANARY@failure.test/?token=TOKEN_CANARY"));
    assert.deepEqual(notifications, []);
  });
}

for (const outcome of [
  "SDK cancellation",
  "unknown failure",
  "lookalike",
  "getter",
  "hostile descriptor",
  "interrupted agent abort",
  "session replacement",
  "throwing UI",
] as const) {
  test(`manual callback keeps cancellation and failure distinct: ${outcome}`, async () => {
    const memory = memoryRuntime();
    const caller = new AbortController();
    let sessionId = "source-session";
    let compactOptions: { onError?: (error: Error) => void } | undefined;
    let reads = 0;
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      signal: caller.signal,
      sessionManager: { getSessionId: () => sessionId },
      select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Compact now")),
      compact: (options: { onError?: (error: Error) => void }) => {
        compactOptions = options;
      },
    });
    await showCodexCompactMenu(memory.runtime, ctx, { signal: new AbortController().signal, isCurrent: () => true });
    assert.ok(compactOptions?.onError);
    if (outcome === "interrupted agent abort") caller.abort(new Error("synthetic-private-reason"));
    if (outcome === "session replacement") sessionId = "replacement-session";
    if (outcome === "throwing UI")
      vi.spyOn((ctx as ExtensionCommandContext).ui, "notify").mockImplementation(() => {
        throw new Error("synthetic-private-error");
      });
    const error =
      outcome === "SDK cancellation"
        ? new Error("Compaction cancelled")
        : outcome === "lookalike"
          ? new Error("Compaction cancelled: synthetic-private-error")
          : new Error("synthetic-private-error");
    if (outcome === "getter")
      Object.defineProperty(error, "message", {
        get: () => {
          reads++;
          return "Compaction cancelled";
        },
      });
    const delivered =
      outcome === "hostile descriptor"
        ? new Proxy(error, {
            getOwnPropertyDescriptor() {
              throw new Error("synthetic-private-error");
            },
          })
        : error;
    assert.doesNotThrow(() => compactOptions?.onError?.(delivered));
    assert.equal(reads, 0);
    assert.deepEqual(
      notifications,
      ["unknown failure", "lookalike", "getter", "hostile descriptor", "interrupted agent abort"].includes(outcome)
        ? [{ message: "Compaction failed.", level: "error" }]
        : [],
    );
  });
}

test("recovery menu action closes first and never calls original compact", async () => {
  const memory = memoryRuntime();
  let closed = false;
  let recovery = 0;
  const { ctx } = createMockContext({
    mode: "tui",
    select: async (_title: string, options: string[]) => options.find((option) => option.startsWith("Recovery export")),
    compact: () => assert.fail("Recovery must not call original compact"),
  });
  const commandCtx = ctx as ExtensionCommandContext;
  const custom = commandCtx.ui.custom;
  commandCtx.ui.custom = async (...args) => {
    const result = await custom(...args);
    closed = true;
    return result;
  };
  await showCodexCompactMenu(memory.runtime, ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    recover: async () => {
      assert.equal(closed, true);
      recovery++;
    },
  });
  assert.equal(recovery, 1);
});

test("non-TUI command reports the settings path without compacting", async () => {
  const memory = memoryRuntime();
  let compactions = 0;
  const { ctx, notifications } = createMockContext({
    mode: "print",
    hasUI: false,
    compact: () => {
      compactions += 1;
    },
  });
  await showCodexCompactMenu(memory.runtime, ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assert.match(notifications[0]?.message ?? "", /pi-codex-compact\.json/);
  assert.equal(compactions, 0);
});
