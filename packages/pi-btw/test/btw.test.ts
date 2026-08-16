import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { test } from "vitest";
import btw, {
  BTW_SETTINGS_FILE,
  type BtwThreadState,
  buildConversationContext,
  buildUserPrompt,
  completeSideQuestion,
  loadBtwThinkingLevel,
  normalizeBtwSettings,
  parseBtwModelReference,
  readBtwSettings,
  resolveBtwModel,
  sanitizeSingleLine,
} from "../src/btw.js";
import { createMockContext, createMockPi } from "./support.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

async function withTempSettings(run: (settingsPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-btw-test-"));
  try {
    await run(join(directory, BTW_SETTINGS_FILE));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("normalizeBtwSettings accepts optional model and thinking level", () => {
  assert.deepEqual(normalizeBtwSettings({}), {});
  assert.deepEqual(normalizeBtwSettings({ futureOption: true }), {});
  assert.deepEqual(normalizeBtwSettings({ model: "anthropic/claude-sonnet-4-5" }), {
    model: "anthropic/claude-sonnet-4-5",
  });
  assert.deepEqual(normalizeBtwSettings({ model: "openrouter/anthropic/claude-sonnet" }), {
    model: "openrouter/anthropic/claude-sonnet",
  });

  for (const thinkingLevel of THINKING_LEVELS) {
    assert.deepEqual(normalizeBtwSettings({ thinkingLevel }), { thinkingLevel });
    assert.deepEqual(normalizeBtwSettings({ model: "test/model", thinkingLevel }), {
      model: "test/model",
      thinkingLevel,
    });
  }

  assert.equal(normalizeBtwSettings(null), undefined);
  assert.equal(normalizeBtwSettings([]), undefined);
  assert.equal(normalizeBtwSettings({ model: "" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "model-without-provider" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "/model" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "provider/" }), undefined);
  assert.equal(normalizeBtwSettings({ model: " provider/model" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "provider/model " }), undefined);
  assert.equal(normalizeBtwSettings({ model: "provider/\nmodel" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "provider/model\u0000suffix" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "provider/\u001b]52;c;payload\u0007" }), undefined);
  assert.equal(normalizeBtwSettings({ model: "provider/model\u009b31m" }), undefined);
  assert.equal(normalizeBtwSettings({ thinkingLevel: null }), undefined);
  assert.equal(normalizeBtwSettings({ thinkingLevel: "huge" }), undefined);
});

test("parseBtwModelReference splits only the first slash", () => {
  assert.deepEqual(parseBtwModelReference("openrouter/anthropic/claude-sonnet"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet",
  });
  assert.equal(parseBtwModelReference("invalid"), undefined);
});

test("resolveBtwModel selects configured model and its credentials", async () => {
  const currentModel = { provider: "current", id: "main" } as Model<Api>;
  const configuredModel = { provider: "openrouter", id: "anthropic/claude" } as Model<Api>;
  const credentialReads: Model<Api>[] = [];
  const warnings: string[] = [];
  const result = await resolveBtwModel({
    settings: { model: "openrouter/anthropic/claude", thinkingLevel: "low" },
    currentModel,
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        provider === "openrouter" && modelId === "anthropic/claude" ? configuredModel : undefined,
      getApiKeyAndHeaders: async (model: Model<Api>) => {
        credentialReads.push(model);
        return { ok: true as const, apiKey: "configured-key", headers: { test: "yes" } };
      },
    } as never,
    warn: (message) => warnings.push(message),
  });

  assert.equal(result?.model, configuredModel);
  assert.equal(result?.auth.apiKey, "configured-key");
  assert.deepEqual(credentialReads, [configuredModel]);
  assert.deepEqual(warnings, []);
});

test("resolveBtwModel accepts header-only and environment-only configured auth", async () => {
  for (const auth of [
    { ok: true as const, headers: { Authorization: "Bearer test" } },
    { ok: true as const, env: { PROVIDER_TOKEN: "test" } },
  ]) {
    const configuredModel = { provider: "custom", id: "side" } as Model<Api>;
    const result = await resolveBtwModel({
      settings: { model: "custom/side" },
      currentModel: undefined,
      modelRegistry: {
        find: () => configuredModel,
        getApiKeyAndHeaders: async () => auth,
      } as never,
    });

    assert.equal(result?.model, configuredModel);
    assert.deepEqual(result?.auth.headers, auth.headers);
    assert.deepEqual(result?.auth.env, auth.env);
  }
});

test("resolveBtwModel preserves deletion markers without treating null-only headers as auth", async () => {
  const configuredModel = { provider: "custom", id: "side" } as Model<Api>;
  const mixedHeaders = { Authorization: null, "X-Provider-Token": "test" };
  const mixed = await resolveBtwModel({
    settings: { model: "custom/side" },
    currentModel: undefined,
    modelRegistry: {
      find: () => configuredModel,
      getApiKeyAndHeaders: async () => ({ ok: true as const, headers: mixedHeaders }),
    } as never,
  });
  assert.deepEqual(mixed?.auth.headers, mixedHeaders);

  const warnings: string[] = [];
  const nullOnly = await resolveBtwModel({
    settings: { model: "custom/side" },
    currentModel: undefined,
    modelRegistry: {
      find: () => configuredModel,
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        headers: { Authorization: null },
      }),
    } as never,
    warn: (message) => warnings.push(message),
  });
  assert.equal(nullOnly, undefined);
  assert.match(warnings[0] ?? "", /no request credentials/u);
});

test("resolveBtwModel inherits current model when no model is configured", async () => {
  const currentModel = { provider: "current", id: "main" } as Model<Api>;
  const result = await resolveBtwModel({
    settings: { thinkingLevel: "high" },
    currentModel,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "current-key" }),
    } as never,
  });

  assert.equal(result?.model, currentModel);
  assert.equal(result?.auth.apiKey, "current-key");
});

test("resolveBtwModel warns and falls back for unavailable configured models", async () => {
  const currentModel = { provider: "current", id: "main" } as Model<Api>;
  for (const configuredAuth of [
    { ok: true as const, apiKey: undefined },
    { ok: false as const, error: "credential command failed" },
  ]) {
    const configuredModel = { provider: "other", id: "side" } as Model<Api>;
    const warnings: string[] = [];
    const result = await resolveBtwModel({
      settings: { model: "other/side" },
      currentModel,
      modelRegistry: {
        find: () => configuredModel,
        getApiKeyAndHeaders: async (model: Model<Api>) =>
          model === configuredModel ? configuredAuth : { ok: true as const, apiKey: "current-key" },
      } as never,
      warn: (message) => warnings.push(message),
    });

    assert.equal(result?.model, currentModel);
    assert.equal(result?.auth.apiKey, "current-key");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /other\/side/);
    assert.match(warnings[0] ?? "", /current\/main/);
  }

  const warnings: string[] = [];
  const missing = await resolveBtwModel({
    settings: { model: "missing/model" },
    currentModel,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "current-key" }),
    } as never,
    warn: (message) => warnings.push(message),
  });
  assert.equal(missing?.model, currentModel);
  assert.match(warnings[0] ?? "", /not found/);
});

test("resolveBtwModel does not retry credentials when configured and current models are identical", async () => {
  const model = { provider: "same", id: "model" } as Model<Api>;
  let credentialReads = 0;
  const result = await resolveBtwModel({
    settings: { model: "same/model" },
    currentModel: model,
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () => {
        credentialReads += 1;
        throw new Error("credential command failed");
      },
    } as never,
  });

  assert.equal(result, undefined);
  assert.equal(credentialReads, 1);
});

test("resolveBtwModel returns undefined when neither configured nor current model is usable", async () => {
  const warnings: string[] = [];
  const result = await resolveBtwModel({
    settings: { model: "missing/model" },
    currentModel: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "unused" }),
    } as never,
    warn: (message) => warnings.push(message),
  });

  assert.equal(result, undefined);
  assert.equal(warnings.length, 1);
});

test("missing pi-btw settings inherit silently without creating a file", async () => {
  await withTempSettings(async (settingsPath) => {
    assert.deepEqual(await readBtwSettings(settingsPath), { kind: "missing" });

    const warnings: string[] = [];
    assert.equal(
      await loadBtwThinkingLevel("high", {
        settingsPath,
        warn: (message) => warnings.push(message),
      }),
      "high",
    );
    assert.deepEqual(warnings, []);
    await assert.rejects(readFile(settingsPath, "utf8"), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    });
  });
});

test("pi-btw settings override the current runtime thinking level", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, "{}\n", "utf8");
    assert.equal(await loadBtwThinkingLevel("medium", { settingsPath }), "medium");

    for (const thinkingLevel of THINKING_LEVELS) {
      await writeFile(settingsPath, `${JSON.stringify({ thinkingLevel })}\n`, "utf8");
      assert.equal(await loadBtwThinkingLevel("medium", { settingsPath }), thinkingLevel);
    }
  });
});

test("invalid pi-btw settings warn and fall back to the runtime level", async () => {
  await withTempSettings(async (settingsPath) => {
    for (const contents of ["{not-json", '{"thinkingLevel":42}\n', '{"thinkingLevel":"huge"}\n']) {
      await writeFile(settingsPath, contents, "utf8");
      const warnings: string[] = [];
      assert.equal(
        await loadBtwThinkingLevel("low", {
          settingsPath,
          warn: (message) => warnings.push(message),
        }),
        "low",
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /pi-btw settings ignored/);
      assert.match(warnings[0] ?? "", /thinkingLevel/);
      assert.match(warnings[0] ?? "", new RegExp(BTW_SETTINGS_FILE));
    }

    await rm(settingsPath, { force: true });
    await mkdir(settingsPath);
    const warnings: string[] = [];
    assert.equal(
      await loadBtwThinkingLevel("medium", {
        settingsPath,
        warn: (message) => warnings.push(message),
      }),
      "medium",
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /pi-btw settings ignored/);
  });
});

test("side-question completion maps thinking levels into provider-neutral options", async () => {
  for (const thinkingLevel of THINKING_LEVELS) {
    let capturedContext: unknown;
    let capturedOptions: Record<string, unknown> | undefined;
    const response = { role: "assistant", stopReason: "stop", content: [] };
    const result = await completeSideQuestion({
      completeSimple: (async (_model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        capturedContext = context;
        capturedOptions = options as Record<string, unknown>;
        return response as never;
      }) as never,
      model: { id: "test-model" } as never,
      question: "Why?",
      conversationContext: "User: context",
      thinkingLevel,
      auth: {
        apiKey: "test-key",
        headers: { "x-test": "yes" },
        env: { TEST_ENV: "yes" },
      },
    });

    assert.equal(result, response);
    assert.match(JSON.stringify(capturedContext), /<side_question>\\nWhy\?/);
    assert.equal(capturedOptions?.apiKey, "test-key");
    assert.deepEqual(capturedOptions?.headers, { "x-test": "yes" });
    assert.deepEqual(capturedOptions?.env, { TEST_ENV: "yes" });
    if (thinkingLevel === "off") {
      assert.equal(Object.hasOwn(capturedOptions ?? {}, "reasoning"), false);
    } else {
      assert.equal(capturedOptions?.reasoning, thinkingLevel);
    }
  }
});

test("btw command routes no arguments through the menu and preserves direct questions", async () => {
  const mock = createMockPi({ thinkingLevel: "low" });
  const selected = {
    model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const menuCalls: string[] = [];
  let fullscreenRuns = 0;
  const threadStarts: Array<{
    initialQuestion?: string;
    thinkingLevel: string;
    rememberThinkingLevelChanges?: boolean;
  }> = [];
  btw(mock.pi, {
    showCommandMenu: async () => {
      menuCalls.push("menu");
      return "start";
    },
    loadSettings: async () => ({ thinkingLevel: "medium" }),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => {
      fullscreenRuns += 1;
      return run(ctx);
    },
    runThread: async (options) => {
      threadStarts.push({
        initialQuestion: options.initialQuestion,
        thinkingLevel: options.thinkingLevel,
        rememberThinkingLevelChanges: options.rememberThinkingLevelChanges,
      });
      return { kind: "closed" };
    },
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  let idleWaits = 0;
  const interactive = createMockContext({
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {
      idleWaits += 1;
    },
  });

  await command.handler("", interactive.ctx);
  await command.handler("direct question", interactive.ctx);

  assert.deepEqual(menuCalls, ["menu"]);
  assert.equal(fullscreenRuns, 2);
  assert.equal(idleWaits, 0);
  assert.deepEqual(threadStarts, [
    {
      initialQuestion: undefined,
      thinkingLevel: "medium",
      rememberThinkingLevelChanges: true,
    },
    {
      initialQuestion: "direct question",
      thinkingLevel: "medium",
      rememberThinkingLevelChanges: true,
    },
  ]);
  assert.deepEqual(mock.thinkingLevels, []);
});

test("btw keeps multiple in-memory threads, resumes selected state, and keeps direct questions fresh", async () => {
  const mock = createMockPi({ thinkingLevel: "low" });
  const selected = {
    model: { provider: "test", id: "side", reasoning: true } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const menuResults: unknown[] = ["start", { kind: "resume", threadId: "btw-1" }, "closed"];
  const menuSnapshots: Array<Array<{ id: string; title: string; questionCount: number }>> = [];
  const states: Array<{
    id: string;
    title?: string;
    thread: { turns: unknown[] };
    thinkingLevel: string;
    updatedAt: number;
  }> = [];
  const initialQuestions: Array<string | undefined> = [];
  const selectedModels: unknown[] = [];
  let modelResolutions = 0;
  btw(mock.pi, {
    showCommandMenu: (async (
      _pi: unknown,
      _ctx: unknown,
      resumeThreads: Array<{ id: string; title: string; questionCount: number }>,
    ) => {
      menuSnapshots.push(resumeThreads.map((thread) => ({ ...thread })));
      return menuResults.shift();
    }) as never,
    loadSettings: async () => ({ thinkingLevel: "medium" }),
    resolveModel: async () => {
      modelResolutions += 1;
      return { kind: "selected", selected };
    },
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async (options: {
      initialQuestion?: string;
      selected: unknown;
      state: {
        id: string;
        title?: string;
        thread: { turns: unknown[] };
        thinkingLevel: string;
        updatedAt: number;
      };
    }) => {
      initialQuestions.push(options.initialQuestion);
      selectedModels.push(options.selected);
      states.push(options.state);
      if (states.length === 1) {
        options.state.title = "First side topic";
        options.state.thread.turns.push({ kind: "error", question: "First side topic", answer: "first error" });
        options.state.thinkingLevel = "high";
        options.state.updatedAt = 10;
      } else if (states.length === 3) {
        options.state.title = "Direct side topic";
        options.state.thread.turns.push({ kind: "error", question: "Direct side topic", answer: "direct error" });
        options.state.updatedAt = 20;
      }
      return { kind: "closed" };
    }) as never,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });

  await command.handler("", interactive.ctx);
  await command.handler("", interactive.ctx);
  await command.handler("Direct side topic", interactive.ctx);
  await command.handler("", interactive.ctx);

  assert.deepEqual(initialQuestions, [undefined, undefined, "Direct side topic"]);
  assert.equal(states[1], states[0]);
  assert.equal(states[1]?.thinkingLevel, "high");
  assert.notEqual(states[2], states[0]);
  assert.equal(states[2]?.thread.turns.length, 1);
  assert.deepEqual(selectedModels, [selected, selected, selected]);
  assert.equal(modelResolutions, 3);
  assert.deepEqual(menuSnapshots, [
    [],
    [{ id: "btw-1", title: "First side topic", questionCount: 1 }],
    [
      { id: "btw-2", title: "Direct side topic", questionCount: 1 },
      { id: "btw-1", title: "First side topic", questionCount: 1 },
    ],
  ]);
});

test("btw resume threads are scoped to the active Pi session branch", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const menuSnapshots: unknown[][] = [];
  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      menuSnapshots.push([...threads]);
      return "closed";
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({ state }: { state: BtwThreadState }) => {
      state.title = "Old session thread";
      state.thread.turns.push({ kind: "error", question: "old", answer: "old" });
      return { kind: "closed" };
    }) as never,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  const firstManager = { getBranch: () => [] };
  const secondManager = { getBranch: () => [] };
  const first = createMockContext({ mode: "tui", hasUI: true, sessionManager: firstManager });
  const second = createMockContext({ mode: "tui", hasUI: true, sessionManager: secondManager });

  for (const handler of mock.events.get("session_start") ?? []) await handler({}, first.ctx);
  await command.handler("remember this", first.ctx);
  for (const handler of mock.events.get("session_tree") ?? []) await handler({}, first.ctx);
  await command.handler("", first.ctx);
  await command.handler("remember after tree", first.ctx);
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, first.ctx);
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, second.ctx);
  await command.handler("", second.ctx);

  assert.deepEqual(menuSnapshots, [[], []]);
});

test("an empty or cancelled fresh btw thread is not retained", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const menuResults: unknown[] = ["start", "closed"];
  const menuSnapshots: Array<Array<{ id: string }>> = [];
  const states: Array<{ id: string; title?: string; thread: { turns: unknown[] } }> = [];
  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, resumeThreads: Array<{ id: string }>) => {
      menuSnapshots.push(resumeThreads.map((thread) => ({ id: thread.id })));
      return menuResults.shift();
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async (options: {
      initialQuestion?: string;
      state: { id: string; title?: string; thread: { turns: unknown[] } };
    }) => {
      states.push(options.state);
      if (states.length === 1) {
        options.state.title = "Retained";
        options.state.thread.turns.push({ kind: "error" });
      }
      return { kind: "closed" };
    }) as never,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });

  await command.handler("Retained", interactive.ctx);
  await command.handler("", interactive.ctx);
  await command.handler("", interactive.ctx);

  assert.deepEqual(menuSnapshots, [[{ id: "btw-1" }], [{ id: "btw-1" }]]);
  assert.equal(states.length, 2);
  assert.equal(states[1]?.thread.turns.length, 0);
});

test("reopening a thread without a new visible result preserves stable activity ordering", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const menuResults: unknown[] = [{ kind: "resume", threadId: "btw-1" }, "closed"];
  const menuSnapshots: Array<Array<{ id: string; title: string }>> = [];
  let runCount = 0;
  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: Array<{ id: string; title: string }>) => {
      menuSnapshots.push(threads.map(({ id, title }) => ({ id, title })));
      return menuResults.shift();
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async (options: {
      state: {
        id: string;
        title?: string;
        thread: { turns: unknown[] };
        updatedAt: number;
      };
    }) => {
      runCount += 1;
      if (runCount === 1) {
        options.state.title = "Older";
        options.state.thread.turns.push({ kind: "error" });
        options.state.updatedAt = 10;
      } else if (runCount === 2) {
        options.state.title = "Newer";
        options.state.thread.turns.push({ kind: "error" });
        options.state.updatedAt = 20;
      }
      return { kind: "closed" };
    }) as never,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });

  await command.handler("Older", interactive.ctx);
  await command.handler("Newer", interactive.ctx);
  await command.handler("", interactive.ctx);
  await command.handler("", interactive.ctx);

  assert.deepEqual(menuSnapshots, [
    [
      { id: "btw-2", title: "Newer" },
      { id: "btw-1", title: "Older" },
    ],
    [
      { id: "btw-2", title: "Newer" },
      { id: "btw-1", title: "Older" },
    ],
  ]);
});

test("a stale Resume id warns and never creates a replacement thread", async () => {
  const mock = createMockPi();
  let fullscreenRuns = 0;
  let threadRuns = 0;
  btw(mock.pi, {
    showCommandMenu: async () => ({ kind: "resume", threadId: "stale-id" }),
    loadSettings: async () => ({}),
    resolveModel: async () => ({
      kind: "selected",
      selected: { model: { provider: "test", id: "side" } as Model<Api>, auth: { apiKey: "key" } },
    }),
    runFullscreen: async (ctx, run) => {
      fullscreenRuns += 1;
      return run(ctx);
    },
    runThread: async () => {
      threadRuns += 1;
      return { kind: "closed" };
    },
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });

  await command.handler("", interactive.ctx);

  assert.equal(fullscreenRuns, 0);
  assert.equal(threadRuns, 0);
  assert.equal(interactive.notifications.length, 1);
  assert.equal(interactive.notifications[0]?.level, "warning");
  assert.match(interactive.notifications[0]?.message ?? "", /no longer available/u);
});

test("separate btw extension instances keep retained Resume state isolated", async () => {
  const first = createMockPi();
  const second = createMockPi();
  const firstSnapshots: unknown[][] = [];
  const secondSnapshots: unknown[][] = [];
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };

  btw(first.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      firstSnapshots.push([...threads]);
      return "closed";
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({ state }: { state?: { title?: string; thread: { turns: unknown[] } } }) => {
      assert.ok(state);
      state.title = "First instance thread";
      state.thread.turns.push({ kind: "error", question: "first", answer: "error" });
      return { kind: "closed" };
    }) as never,
  });
  btw(second.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      secondSnapshots.push([...threads]);
      return "closed";
    }) as never,
  });

  const command = first.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("first instance", interactive.ctx);
  await command.handler("", interactive.ctx);
  await second.commands.get("btw")?.handler("", interactive.ctx);

  assert.deepEqual(firstSnapshots, [[{ id: "btw-1", title: "First instance thread", questionCount: 1 }]]);
  assert.deepEqual(secondSnapshots, [[]]);
});

test("overlapping Resume invocations serialize a leased side thread", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const snapshots: unknown[][] = [];
  let menuCalls = 0;
  let runCount = 0;
  let settingsReads = 0;
  let modelResolutions = 0;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let finishRun!: () => void;
  const heldRun = new Promise<void>((resolve) => {
    finishRun = resolve;
  });

  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      snapshots.push([...threads]);
      menuCalls += 1;
      return menuCalls <= 2 ? { kind: "resume", threadId: "btw-1" } : "closed";
    }) as never,
    loadSettings: async () => {
      settingsReads += 1;
      return {};
    },
    resolveModel: async () => {
      modelResolutions += 1;
      return { kind: "selected", selected };
    },
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({ state }: { state?: { title?: string; thread: { turns: unknown[] } } }) => {
      assert.ok(state);
      runCount += 1;
      if (runCount === 1) {
        state.title = "Seed thread";
        state.thread.turns.push({ kind: "error", question: "seed", answer: "error" });
        return { kind: "closed" };
      }
      markEntered();
      await heldRun;
      return { kind: "closed" };
    }) as never,
  });

  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("seed", interactive.ctx);

  const activeResume = command.handler("", interactive.ctx);
  await entered;
  await command.handler("", interactive.ctx);

  assert.deepEqual(snapshots, [[{ id: "btw-1", title: "Seed thread", questionCount: 1 }], []]);
  assert.equal(runCount, 2);
  assert.equal(settingsReads, 2);
  assert.equal(modelResolutions, 2);
  assert.equal(interactive.notifications.at(-1)?.level, "warning");
  assert.match(interactive.notifications.at(-1)?.message ?? "", /already active/u);

  finishRun();
  await activeResume;
  await command.handler("", interactive.ctx);
  assert.deepEqual(snapshots[2], [{ id: "btw-1", title: "Seed thread", questionCount: 1 }]);
});

test("a cancelled resume releases its lease for a later invocation", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const snapshots: unknown[][] = [];
  let menuCalls = 0;
  let modelResolutions = 0;
  let runCount = 0;

  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      snapshots.push([...threads]);
      menuCalls += 1;
      return menuCalls === 1 ? { kind: "resume", threadId: "btw-1" } : "closed";
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => {
      modelResolutions += 1;
      return modelResolutions === 1 ? { kind: "selected", selected } : { kind: "cancelled" };
    },
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({ state }: { state?: { title?: string; thread: { turns: unknown[] } } }) => {
      assert.ok(state);
      runCount += 1;
      state.title = "Cancellable thread";
      state.thread.turns.push({ kind: "error" });
      return { kind: "closed" };
    }) as never,
  });

  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("seed", interactive.ctx);
  await command.handler("", interactive.ctx);
  await command.handler("", interactive.ctx);

  assert.equal(runCount, 1);
  assert.equal(modelResolutions, 2);
  assert.deepEqual(snapshots, [
    [{ id: "btw-1", title: "Cancellable thread", questionCount: 1 }],
    [{ id: "btw-1", title: "Cancellable thread", questionCount: 1 }],
  ]);
  assert.equal(interactive.notifications.at(-1)?.message, "Cancelled");
});

test("a resolver exception releases a resume lease", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const snapshots: unknown[][] = [];
  let menuCalls = 0;
  let modelResolutions = 0;

  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      snapshots.push([...threads]);
      menuCalls += 1;
      return menuCalls === 1 ? { kind: "resume", threadId: "btw-1" } : "closed";
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => {
      modelResolutions += 1;
      if (modelResolutions === 1) return { kind: "selected", selected };
      throw new Error("credentials unavailable");
    },
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({ state }: { state?: { title?: string; thread: { turns: unknown[] } } }) => {
      assert.ok(state);
      state.title = "Resolver failure thread";
      state.thread.turns.push({ kind: "error" });
      return { kind: "closed" };
    }) as never,
  });

  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("seed", interactive.ctx);
  await assert.rejects(command.handler("", interactive.ctx), /credentials unavailable/u);
  await command.handler("", interactive.ctx);

  assert.deepEqual(snapshots, [
    [{ id: "btw-1", title: "Resolver failure thread", questionCount: 1 }],
    [{ id: "btw-1", title: "Resolver failure thread", questionCount: 1 }],
  ]);
});

test("a thrown side-thread run releases a resume lease", async () => {
  const mock = createMockPi();
  const selected = {
    model: { provider: "test", id: "side" } as Model<Api>,
    auth: { apiKey: "key" },
  };
  const snapshots: unknown[][] = [];
  let menuCalls = 0;
  let runCount = 0;

  btw(mock.pi, {
    showCommandMenu: (async (_pi: unknown, _ctx: unknown, threads: unknown[]) => {
      snapshots.push([...threads]);
      menuCalls += 1;
      return menuCalls === 1 ? { kind: "resume", threadId: "btw-1" } : "closed";
    }) as never,
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({ state }: { state?: { title?: string; thread: { turns: unknown[] } } }) => {
      assert.ok(state);
      runCount += 1;
      if (runCount === 1) {
        state.title = "Thrown run thread";
        state.thread.turns.push({ kind: "error" });
        return { kind: "closed" };
      }
      throw new Error("side-thread failed");
    }) as never,
  });

  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("seed", interactive.ctx);
  await assert.rejects(command.handler("", interactive.ctx), /side-thread failed/u);
  await command.handler("", interactive.ctx);

  assert.deepEqual(snapshots, [
    [{ id: "btw-1", title: "Thrown run thread", questionCount: 1 }],
    [{ id: "btw-1", title: "Thrown run thread", questionCount: 1 }],
  ]);
});

test("resumed threads use credentials resolved for the current invocation", async () => {
  const mock = createMockPi();
  const selected = [
    {
      model: { provider: "test", id: "side-first" } as Model<Api>,
      auth: { apiKey: "first-key" },
    },
    {
      model: { provider: "test", id: "side-latest" } as Model<Api>,
      auth: { apiKey: "latest-key" },
    },
  ];
  let menuCalls = 0;
  let modelResolutions = 0;
  const runSelections: unknown[] = [];

  btw(mock.pi, {
    showCommandMenu: async () => {
      menuCalls += 1;
      return { kind: "resume", threadId: "btw-1" };
    },
    loadSettings: async () => ({}),
    resolveModel: async () => {
      const result = selected[modelResolutions];
      modelResolutions += 1;
      assert.ok(result);
      return { kind: "selected", selected: result };
    },
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (async ({
      state,
      selected: resolved,
    }: {
      state?: { title?: string; thread: { turns: unknown[] } };
      selected: unknown;
    }) => {
      assert.ok(state);
      runSelections.push(resolved);
      state.title ||= "Fresh credentials thread";
      state.thread.turns.push({ kind: "error" });
      return { kind: "closed" };
    }) as never,
  });

  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({ mode: "tui", hasUI: true });
  await command.handler("first question", interactive.ctx);
  await command.handler("", interactive.ctx);

  assert.equal(menuCalls, 1);
  assert.equal(modelResolutions, 2);
  assert.deepEqual(runSelections, selected);
});

test("factory activity ordering survives repeated and backward wall-clock timestamps", async () => {
  const originalNow = Date.now;
  let clock = 100;
  Date.now = () => clock;
  try {
    const mock = createMockPi();
    const selected = {
      model: { provider: "test", id: "side" } as Model<Api>,
      auth: { apiKey: "key" },
    };
    const snapshots: Array<Array<{ id: string; title: string; questionCount: number }>> = [];
    let runCount = 0;
    btw(mock.pi, {
      showCommandMenu: (async (
        _pi: unknown,
        _ctx: unknown,
        threads: Array<{ id: string; title: string; questionCount: number }>,
      ) => {
        snapshots.push(threads.map((thread) => ({ ...thread })));
        return "closed";
      }) as never,
      loadSettings: async () => ({}),
      resolveModel: async () => ({ kind: "selected", selected }),
      runFullscreen: async (ctx, run) => run(ctx),
      runThread: (async ({
        state,
      }: {
        state?: { title?: string; thread: { turns: unknown[] }; updatedAt: number };
      }) => {
        assert.ok(state);
        runCount += 1;
        state.title = `Thread ${runCount}`;
        state.thread.turns.push({ kind: "error" });
        state.updatedAt = Date.now();
        return { kind: "closed" };
      }) as never,
    });

    const command = mock.commands.get("btw");
    assert.ok(command);
    const interactive = createMockContext({ mode: "tui", hasUI: true });
    await command.handler("first", interactive.ctx);
    await command.handler("second", interactive.ctx);
    await command.handler("", interactive.ctx);
    clock = 50;
    await command.handler("third", interactive.ctx);
    await command.handler("", interactive.ctx);

    assert.deepEqual(snapshots, [
      [
        { id: "btw-2", title: "Thread 2", questionCount: 1 },
        { id: "btw-1", title: "Thread 1", questionCount: 1 },
      ],
      [
        { id: "btw-3", title: "Thread 3", questionCount: 1 },
        { id: "btw-2", title: "Thread 2", questionCount: 1 },
        { id: "btw-1", title: "Thread 1", questionCount: 1 },
      ],
    ]);
  } finally {
    Date.now = originalNow;
  }
});

test("btw command cancellation at the no-argument menu does not resolve a model", async () => {
  const mock = createMockPi();
  let modelResolutions = 0;
  btw(mock.pi, {
    showCommandMenu: async () => "closed",
    loadSettings: async () => ({}),
    resolveModel: async () => {
      modelResolutions += 1;
      return { kind: "unavailable" };
    },
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  await command.handler("", createMockContext({ mode: "tui", hasUI: true }).ctx);

  assert.equal(modelResolutions, 0);
});

test("btw command ignores stale-context notification failures after an async boundary", async () => {
  const mock = createMockPi();
  btw(mock.pi, {
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "unavailable" }),
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  const interactive = createMockContext({
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {
        throw new Error("Extension context is no longer active");
      },
    },
  });

  assert.equal(await command.handler("direct question", interactive.ctx), undefined);
});

test("btw command rejects non-TUI mode before reading the runtime thinking level", async () => {
  const mock = createMockPi();
  let thinkingLevelReads = 0;
  mock.rawPi.getThinkingLevel = () => {
    thinkingLevelReads += 1;
    return "medium";
  };
  btw(mock.pi);
  assert.equal(thinkingLevelReads, 0);

  const command = mock.commands.get("btw");
  assert.ok(command);
  const nonInteractive = createMockContext({ mode: "print", hasUI: false });
  await command.handler("", nonInteractive.ctx);

  assert.equal(mock.commands.size, 1);
  assert.equal(command.description, "Ask a quick side question without adding it to the main conversation");
  assert.equal(nonInteractive.notifications[0]?.level, "error");
  assert.doesNotMatch(nonInteractive.notifications[0]?.message ?? "", /Usage/);
  assert.equal(thinkingLevelReads, 0);
});

test("buildConversationContext formats user, assistant, and tool content", () => {
  const context = buildConversationContext([
    { type: "ignored", message: { role: "user", content: "skip" } },
    {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: " Inspect this " },
          { type: "toolCall", name: "read", arguments: { path: "README.md" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "toolResult", name: "read", result: { ok: true } }],
      },
    },
  ]);

  assert.match(context, /User: Inspect this\nTool call: read\(\{"path":"README\.md"\}\)/);
  assert.match(context, /Assistant \(length\): Tool result from read: \{"ok":true\}/);
  assert.doesNotMatch(context, /skip/);
});

test("buildUserPrompt falls back when no conversation context exists", () => {
  const prompt = buildUserPrompt("What now?", "");

  assert.match(prompt, /<side_question>\nWhat now\?\n<\/side_question>/);
  assert.match(prompt, /No prior conversation context was available/);
});

test("sanitizeSingleLine removes controls and collapses whitespace", () => {
  assert.equal(sanitizeSingleLine(" /btw\nhello\t\u0000 world  "), "/btw hello world");
});
