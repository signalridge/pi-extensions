import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  clampThinkingLevel,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
  getSystemMessageText,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_NAME,
  type AdvisorDetails,
  buildAdvisorPrompt,
  MAX_ADVISOR_ANSWER_CHARS,
  registerBtwAdvisor,
  runAdvisor,
} from "../src/advisor.js";
import { resolveConfiguredBtwModel } from "../src/btw.js";
import piBtw from "../src/index.js";
import { BTW_SETTINGS_FILE, normalizeBtwSettings, readBtwSettings } from "../src/settings.js";
import type { CompleteSimpleFunction } from "../src/side-thread.js";
import { createMockContext, createMockPi } from "./support.js";

const REVIEWER = "reviewer-faux/strong";

type Request = {
  context: TranscriptContext;
  options: SimpleStreamOptions | undefined;
};

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-btw-advisor-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createFauxRuntime(directory: string, providers: ReturnType<typeof fauxProvider>[]) {
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  for (const faux of providers) runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

function reviewerProvider() {
  return fauxProvider({
    provider: "reviewer-faux",
    api: "advisor-reviewer-faux",
    models: [{ id: "strong", reasoning: true }],
  });
}

function mainProvider() {
  return fauxProvider({
    provider: "main-faux",
    api: "advisor-main-faux",
    models: [{ id: "worker" }],
  });
}

function seededSession(directory: string): SessionManager {
  const session = SessionManager.inMemory(directory);
  session.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "Fix the parser" },
      { type: "image", data: "SECRET_IMAGE_BYTES", mimeType: "image/png" },
    ],
    timestamp: 1,
  });
  session.appendMessage(
    fauxAssistantMessage(
      [
        fauxThinking("PRIVATE_REASONING"),
        fauxText("Reading parser.ts"),
        fauxToolCall("read", { path: "src/parser.ts" }, { id: "call-1" }),
      ],
      { stopReason: "toolUse", timestamp: 2 },
    ),
  );
  session.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "export function parse() {}" }],
    isError: false,
    timestamp: 3,
  });
  return session;
}

const SEEDED_CONTEXT = [
  "User: Fix the parser",
  'Assistant (toolUse): Reading parser.ts\nTool call: read({"path":"src/parser.ts"})',
  "Tool result from read: export function parse() {}",
].join("\n\n");

function userText(context: TranscriptContext): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""),
    );
}

function toolNames(context: TranscriptContext | undefined): string[] {
  return context ? getCurrentTools(context.messages).map((tool) => tool.name) : [];
}

function systemText(context: TranscriptContext): string {
  return context.messages
    .filter((message) => message.role === "system")
    .map((message) => getSystemMessageText(message))
    .join("\n");
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

function response(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { ...fauxAssistantMessage(text), ...overrides };
}

/** A registry stub for credential and destination paths the faux runtime cannot express. */
function stubRegistry(model: Model<Api> | undefined, auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>) {
  return {
    find: () => model,
    getApiKeyAndHeaders: async () => auth,
    getProvider: () => undefined,
  };
}

const physicalReviewer = {
  provider: "reviewer-faux",
  id: "strong",
  api: "advisor-reviewer-faux",
  baseUrl: "https://reviewer.example",
  reasoning: false,
} as Model<Api>;

test("pi-btw settings accept a provider/model-id advisorModel and reject malformed references", async () => {
  assert.deepEqual(normalizeBtwSettings({ advisorModel: "openrouter/anthropic/claude" }), {
    advisorModel: "openrouter/anthropic/claude",
  });
  assert.deepEqual(normalizeBtwSettings({ model: "a/b", advisorModel: "c/d" }), { model: "a/b", advisorModel: "c/d" });
  for (const advisorModel of ["no-separator", "/model", "provider/", "provider/model id", 42, null]) {
    assert.equal(normalizeBtwSettings({ advisorModel }), undefined, String(advisorModel));
  }
  await withDirectory(async (directory) => {
    const settingsPath = join(directory, BTW_SETTINGS_FILE);
    await writeFile(settingsPath, JSON.stringify({ advisorModel: REVIEWER, thinkingLevel: "low" }), "utf8");
    assert.deepEqual(await readBtwSettings(settingsPath), {
      kind: "loaded",
      settings: { advisorModel: REVIEWER, thinkingLevel: "low" },
    });
  });
});

test("the configured-model resolver reports each outcome without falling back", async () => {
  await withDirectory(async (directory) => {
    const reviewer = reviewerProvider();
    const registry = new ModelRegistry(await createFauxRuntime(directory, [reviewer]));
    const selected = await resolveConfiguredBtwModel(REVIEWER, registry);
    assert.equal(selected.kind, "selected");
    assert.equal(selected.kind === "selected" && selected.selected.model.id, "strong");
    assert.deepEqual(await resolveConfiguredBtwModel("reviewer-faux/absent", registry), { kind: "missing" });
    assert.deepEqual(await resolveConfiguredBtwModel("no-separator", registry), { kind: "invalid" });
    assert.deepEqual(await resolveConfiguredBtwModel(REVIEWER, registry, () => false), { kind: "stale" });
  });
  assert.deepEqual(
    await resolveConfiguredBtwModel(REVIEWER, stubRegistry(physicalReviewer, { ok: false, error: "no key" })),
    { kind: "unavailable", model: physicalReviewer, reason: "no key" },
  );
  const throwing = {
    find: () => physicalReviewer,
    getApiKeyAndHeaders: async () => {
      throw new Error("keychain locked");
    },
  };
  assert.deepEqual(await resolveConfiguredBtwModel(REVIEWER, throwing), {
    kind: "failed",
    model: physicalReviewer,
    reason: "keychain locked",
  });
  const overridden = await resolveConfiguredBtwModel(
    REVIEWER,
    stubRegistry(physicalReviewer, {
      ok: true,
      baseUrl: "https://elsewhere.example",
    }),
  );
  assert.equal(overridden.kind === "selected" && overridden.selected.endpointOverridden, true);
});

test("advisor registers only for an interactive session whose settings name a known physical reviewer", async () => {
  const registry = stubRegistry(physicalReviewer, { ok: true });
  const start = async (
    loaded: Awaited<ReturnType<typeof readBtwSettings>>,
    overrides: Record<string, unknown> = {},
    sessionStarts = 1,
  ) => {
    const host = createMockPi();
    let reads = 0;
    registerBtwAdvisor(host.pi, {
      readSettings: async () => {
        reads += 1;
        return loaded;
      },
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      modelRegistry: registry,
      ...overrides,
    });
    for (let index = 0; index < sessionStarts; index++) {
      for (const handler of host.events.get("session_start") ?? []) await handler({ reason: "startup" }, context.ctx);
    }
    return {
      tools: host.tools.map((tool) => tool.name),
      notifications: context.notifications,
      reads,
    };
  };

  assert.deepEqual(await start({ kind: "missing" }), {
    tools: [],
    notifications: [],
    reads: 1,
  });
  assert.deepEqual(await start({ kind: "loaded", settings: { model: "other/model" } }), {
    tools: [],
    notifications: [],
    reads: 1,
  });
  assert.deepEqual(await start({ kind: "invalid", reason: "invalid JSON" }), {
    tools: [],
    notifications: [],
    reads: 1,
  });

  const configured = {
    kind: "loaded",
    settings: { advisorModel: REVIEWER },
  } as const;
  assert.deepEqual(await start(configured, {}, 2), {
    tools: [ADVISOR_TOOL_NAME],
    notifications: [],
    reads: 1,
  });
  // Managed subagent children and print/JSON runs bind without a UI context.
  assert.deepEqual(await start(configured, { mode: "print", hasUI: false }), {
    tools: [],
    notifications: [],
    reads: 0,
  });

  const missing = await start(configured, {
    modelRegistry: stubRegistry(undefined, { ok: true }),
  });
  assert.deepEqual(missing.tools, []);
  assert.match(missing.notifications[0]?.message ?? "", /advisorModel reviewer-faux\/strong was not found/);
  const virtual = await start(configured, {
    modelRegistry: stubRegistry({ ...physicalReviewer, api: "pi-virtual" } as Model<Api>, { ok: true }),
  });
  assert.deepEqual(virtual.tools, []);
  assert.match(virtual.notifications[0]?.message ?? "", /virtual model/);
});

test("the registered advisor tool takes one optional bounded question", async () => {
  const host = createMockPi();
  registerBtwAdvisor(host.pi, {
    readSettings: async () => ({
      kind: "loaded",
      settings: { advisorModel: REVIEWER },
    }),
  });
  const context = createMockContext({
    hasUI: true,
    modelRegistry: stubRegistry(physicalReviewer, { ok: true }),
  });
  for (const handler of host.events.get("session_start") ?? []) await handler({ reason: "startup" }, context.ctx);
  const tool = host.tools[0] as {
    parameters: {
      required?: string[];
      properties: Record<string, { maxLength?: number }>;
    };
  };
  assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
  assert.equal(tool.parameters.required, undefined);
  assert.equal(tool.parameters.properties.question?.maxLength, 2_000);
});

test("advisor sends the reused side-thread branch context to the reviewer with no tools and its own routing identity", async () => {
  await withDirectory(async (directory) => {
    const reviewer = reviewerProvider();
    const registry = new ModelRegistry(await createFauxRuntime(directory, [reviewer]));
    const requests: Request[] = [];
    reviewer.setResponses([
      (context, options) => {
        requests.push({ context, options });
        return fauxAssistantMessage("Add a regression test before touching parse().");
      },
      (context, options) => {
        requests.push({ context, options });
        return fauxAssistantMessage("Looks fine.");
      },
    ]);
    const sessionManager = seededSession(directory);
    const ctx = {
      hasUI: true,
      model: mainProvider().getModel() as Model<Api>,
      sessionManager,
      modelRegistry: registry,
    };
    const updates: string[] = [];
    const result = await runAdvisor({
      reference: REVIEWER,
      routingId: "advisor-routing-id",
      question: "  Is editing parse() directly safe?  ",
      thinkingLevel: "high",
      ctx,
      onUpdate: (partial) => updates.push(textOf(partial)),
    });

    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "Add a regression test before touching parse().");
    const details = result.details as AdvisorDetails;
    assert.equal(details.model, REVIEWER);
    assert.equal(details.thinkingLevel, "high");
    assert.equal(typeof details.usage?.totalTokens, "number");
    assert.deepEqual(result.usage, details.usage);
    assert.deepEqual(updates, [`Consulting ${REVIEWER}…`]);

    assert.equal(requests.length, 1);
    const [{ context, options }] = requests;
    assert.deepEqual(
      context.messages.map((message) => message.role),
      ["system", "user"],
    );
    assert.equal(systemText(context), ADVISOR_SYSTEM_PROMPT);
    assert.deepEqual(userText(context), [buildAdvisorPrompt("Is editing parse() directly safe?", SEEDED_CONTEXT)]);
    // The reviewer cannot call tools, including this one.
    assert.deepEqual(getCurrentTools(context.messages), []);
    assert.doesNotMatch(JSON.stringify(context), /SECRET_IMAGE_BYTES|PRIVATE_REASONING|toolsAdded/);
    assert.equal(options?.sessionId, "advisor-routing-id");
    assert.equal(options?.reasoning, "high");

    await runAdvisor({
      reference: REVIEWER,
      routingId: "advisor-routing-id",
      thinkingLevel: "off",
      ctx,
    });
    assert.equal(requests[1]?.options?.sessionId, "advisor-routing-id");
    assert.notEqual(requests[1]?.options?.sessionId, sessionManager.getSessionId());
    assert.equal(requests[1]?.options?.reasoning, undefined);
    assert.deepEqual(userText(requests[1]?.context as TranscriptContext), [buildAdvisorPrompt("", SEEDED_CONTEXT)]);
    assert.match(buildAdvisorPrompt("", SEEDED_CONTEXT), /No specific question/);
  });
});

test("advisor clamps the session thinking level to the reviewer model", async () => {
  const levels: Array<string | undefined> = [];
  const completeSimple: CompleteSimpleFunction = async (_model, _context, options) => {
    levels.push(options?.reasoning);
    return response("ok");
  };
  const ctx = {
    hasUI: true,
    model: undefined,
    sessionManager: SessionManager.inMemory(),
    modelRegistry: stubRegistry(physicalReviewer, { ok: true }),
  };
  const result = await runAdvisor({
    reference: REVIEWER,
    routingId: "id",
    thinkingLevel: "max",
    ctx,
    completeSimple,
  });
  assert.deepEqual(levels, [undefined]);
  assert.equal((result.details as AdvisorDetails).thinkingLevel, clampThinkingLevel(physicalReviewer, "max"));
});

test("advisor propagates the tool-call abort signal to the reviewer request", async () => {
  await withDirectory(async (directory) => {
    const reviewer = reviewerProvider();
    const registry = new ModelRegistry(await createFauxRuntime(directory, [reviewer]));
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    reviewer.setResponses([
      async (_context, options) => {
        receivedSignal = options?.signal;
        controller.abort();
        return fauxAssistantMessage("LATE_ANSWER");
      },
    ]);
    const ctx = {
      hasUI: true,
      model: undefined,
      sessionManager: seededSession(directory),
      modelRegistry: registry,
    };
    const result = await runAdvisor({
      reference: REVIEWER,
      routingId: "id",
      thinkingLevel: "off",
      ctx,
      signal: controller.signal,
    });
    assert.equal(receivedSignal, controller.signal);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /cancelled before the reviewer answered/);
    assert.doesNotMatch(JSON.stringify(result), /LATE_ANSWER/);

    const calls = reviewer.state.callCount;
    const preAborted = await runAdvisor({
      reference: REVIEWER,
      routingId: "id",
      thinkingLevel: "off",
      ctx,
      signal: AbortSignal.abort(),
    });
    assert.equal(preAborted.isError, true);
    assert.equal(reviewer.state.callCount, calls);
  });
});

test.each(["resolve", "reject"] as const)(
  "advisor abort releases stalled credentials and observes late %s without dispatch",
  async (outcome) => {
    let resolve!: (auth: { ok: true }) => void;
    let reject!: (error: Error) => void;
    const credentials = new Promise<{ ok: true }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const controller = new AbortController();
    let calls = 0;
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => {
      added++;
      add(...args);
    };
    controller.signal.removeEventListener = (...args) => {
      removed++;
      remove(...args);
    };
    const pending = runAdvisor({
      reference: REVIEWER,
      routingId: "id",
      thinkingLevel: "off",
      signal: controller.signal,
      ctx: {
        hasUI: true,
        model: undefined,
        sessionManager: SessionManager.inMemory(),
        modelRegistry: { ...stubRegistry(physicalReviewer, { ok: true }), getApiKeyAndHeaders: () => credentials },
      },
      completeSimple: async () => {
        calls++;
        return response("late");
      },
    });
    controller.abort();
    const result = await pending; // credentials still unresolved: cancellation cannot wait for OAuth.
    assert.equal(result.isError, true);
    assert.match(textOf(result), /cancelled/);
    assert.equal(calls, 0);
    assert.equal(added, 1);
    assert.equal(removed, 1);
    if (outcome === "resolve") resolve({ ok: true });
    else reject(new Error("late refresh failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
  },
);

test("advisor maps every reviewer failure to an error result and never fabricates an answer", async () => {
  const usage: Usage = {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  };
  const run = (completeSimple: CompleteSimpleFunction) =>
    runAdvisor({
      reference: REVIEWER,
      routingId: "id",
      thinkingLevel: "off",
      ctx: {
        hasUI: true,
        model: undefined,
        sessionManager: SessionManager.inMemory(),
        modelRegistry: stubRegistry(physicalReviewer, { ok: true }),
      },
      completeSimple,
    });

  const providerError = await run(async () =>
    response("", {
      stopReason: "error",
      errorMessage: "overloaded\nretry later",
      usage,
    }),
  );
  assert.equal(providerError.isError, true);
  assert.equal(textOf(providerError), `The reviewer ${REVIEWER} returned an error: overloaded retry later`);
  assert.deepEqual(providerError.details, {
    model: REVIEWER,
    error: textOf(providerError),
    usage,
  });
  assert.deepEqual(providerError.usage, usage);

  const thrown = await run(async () => {
    throw new Error("socket hang up");
  });
  assert.equal(thrown.isError, true);
  assert.equal(textOf(thrown), `The reviewer ${REVIEWER} request failed: socket hang up`);

  const malformed = await run(async () => ({}) as AssistantMessage);
  assert.equal(malformed.isError, true);
  assert.match(textOf(malformed), /malformed response/);

  const empty = await run(async () => response("   ", { usage }));
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /returned no text/);
  assert.deepEqual(empty.usage, usage);

  const success = await run(async () => response("Use the existing tokenizer.", { usage }));
  assert.equal(success.isError, undefined);
  assert.deepEqual(success.details, {
    model: REVIEWER,
    thinkingLevel: "off",
    usage,
  });
  assert.deepEqual(success.usage, usage);

  const long = await run(async () => response("x".repeat(MAX_ADVISOR_ANSWER_CHARS + 500)));
  assert.equal(
    textOf(long),
    `${"x".repeat(MAX_ADVISOR_ANSWER_CHARS)}\n\n[Reviewer reply truncated at ${MAX_ADVISOR_ANSWER_CHARS} characters.]`,
  );
  assert.equal((long.details as AdvisorDetails).truncated, true);
});

test("advisor refuses without a provider request for the current model, unsafe destinations and headless sessions", async () => {
  let calls = 0;
  const completeSimple: CompleteSimpleFunction = async () => {
    calls += 1;
    return response("should not be sent");
  };
  const run = (overrides: Partial<Parameters<typeof runAdvisor>[0]["ctx"]>) =>
    runAdvisor({
      reference: REVIEWER,
      routingId: "id",
      thinkingLevel: "off",
      ctx: {
        hasUI: true,
        model: undefined,
        sessionManager: SessionManager.inMemory(),
        modelRegistry: stubRegistry(physicalReviewer, { ok: true }),
        ...overrides,
      },
      completeSimple,
    });

  const cases: Array<[Partial<Parameters<typeof runAdvisor>[0]["ctx"]>, RegExp]> = [
    [{ model: physicalReviewer }, /is the current session model/],
    [{ hasUI: false }, /only in interactive sessions/],
    [{ modelRegistry: stubRegistry(undefined, { ok: true }) }, /is not in Pi's model registry/],
    [
      {
        modelRegistry: stubRegistry(physicalReviewer, {
          ok: false,
          error: "No API key",
        }),
      },
      /unavailable: No API key/,
    ],
    [
      {
        modelRegistry: stubRegistry(physicalReviewer, {
          ok: true,
          baseUrl: "https://elsewhere.example",
        }),
      },
      /endpoint other than the registered one/,
    ],
    [
      {
        modelRegistry: stubRegistry({ ...physicalReviewer, api: "pi-virtual" } as Model<Api>, { ok: true }),
      },
      /virtual model/,
    ],
  ];
  for (const [overrides, pattern] of cases) {
    const result = await run(overrides);
    assert.equal(result.isError, true, String(pattern));
    assert.match(textOf(result), pattern);
    assert.equal((result.details as AdvisorDetails).model, REVIEWER);
  }
  assert.equal(calls, 0);

  // The same registered endpoint is not an override.
  const sameEndpoint = await run({
    modelRegistry: stubRegistry(physicalReviewer, {
      ok: true,
      baseUrl: physicalReviewer.baseUrl,
    }),
  });
  assert.equal(sameEndpoint.isError, undefined);
  assert.equal(calls, 1);
});

test("real Pi 1.4 session: the main model calls advisor and receives the reviewer's answer", async () => {
  await withDirectory(async (root) => {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    await writeFile(join(agentDir, BTW_SETTINGS_FILE), JSON.stringify({ advisorModel: REVIEWER }), "utf8");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sessions: AgentSession[] = [];
    try {
      const main = mainProvider();
      const reviewer = reviewerProvider();
      const runtime = await createFauxRuntime(root, [main, reviewer]);
      const extensionErrors: string[] = [];
      const start = async (mode: "rpc" | "print") => {
        const settingsManager = SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: false },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [piBtw],
        });
        await resourceLoader.reload();
        assert.deepEqual(resourceLoader.getExtensions().errors, []);
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime: runtime,
          model: main.getModel(),
          thinkingLevel: "off",
          settingsManager,
          sessionManager: SessionManager.inMemory(cwd),
          resourceLoader,
          noTools: "builtin",
        });
        sessions.push(session);
        await session.bindExtensions({
          mode,
          ...(mode === "rpc" ? { uiContext: { notify() {} } as never } : {}),
          onError: (error) => extensionErrors.push(`${error.event}: ${error.error}`),
        });
        return session;
      };

      const mainRequests: TranscriptContext[] = [];
      const reviewerRequests: Request[] = [];
      main.setResponses([
        (context) => {
          mainRequests.push(context);
          return fauxAssistantMessage(
            fauxToolCall(ADVISOR_TOOL_NAME, { question: "Is the plan safe?" }, { id: "adv-1" }),
            {
              stopReason: "toolUse",
            },
          );
        },
        (context) => {
          mainRequests.push(context);
          return fauxAssistantMessage("Following the reviewer.");
        },
      ]);
      reviewer.setResponses([
        (context, options) => {
          reviewerRequests.push({ context, options });
          return fauxAssistantMessage("Run the parser tests before editing.");
        },
      ]);

      const session = await start("rpc");
      await session.prompt("Refactor the parser");

      assert.equal(mainRequests.length, 2);
      assert.ok(toolNames(mainRequests[0]).includes(ADVISOR_TOOL_NAME));
      assert.equal(reviewerRequests.length, 1);
      const [{ context, options }] = reviewerRequests;
      assert.equal(systemText(context), ADVISOR_SYSTEM_PROMPT);
      assert.deepEqual(getCurrentTools(context.messages), []);
      const [prompt] = userText(context);
      assert.match(prompt ?? "", /<agent_question>\nIs the plan safe\?\n<\/agent_question>/);
      assert.match(prompt ?? "", /User: Refactor the parser/);
      assert.notEqual(options?.sessionId, session.sessionManager.getSessionId());

      const toolResult = mainRequests[1]?.messages.find((message) => message.role === "toolResult");
      assert.ok(toolResult && toolResult.role === "toolResult");
      assert.equal(toolResult.toolName, ADVISOR_TOOL_NAME);
      assert.equal(toolResult.isError, false);
      assert.deepEqual(toolResult.content, [{ type: "text", text: "Run the parser tests before editing." }]);
      const stored = session.sessionManager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
      assert.ok(stored?.type === "message" && stored.message.role === "toolResult");
      assert.equal((stored.message.details as AdvisorDetails).model, REVIEWER);

      // A session bound without a UI (print mode, as for managed subagent children) never sees the tool.
      main.setResponses([
        (context) => {
          mainRequests.push(context);
          return fauxAssistantMessage("headless answer");
        },
      ]);
      const headless = await start("print");
      await headless.prompt("Headless task");
      assert.equal(toolNames(mainRequests.at(-1)).includes(ADVISOR_TOOL_NAME), false);
      assert.equal(reviewerRequests.length, 1);
      assert.deepEqual(extensionErrors, []);
    } finally {
      for (const session of sessions) {
        await session.abort();
        session.dispose();
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
