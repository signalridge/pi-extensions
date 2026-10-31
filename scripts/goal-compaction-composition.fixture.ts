import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  type Model,
  type Provider,
  Type,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  buildSessionProjection,
  createAgentSession,
  createEventBus,
  createExtensionRuntime,
  type Extension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { parseCheckpointDetails, projectCheckpointContext } from "../packages/pi-codex-compact/src/checkpoint.js";
import { createCodexCompactExtension } from "../packages/pi-codex-compact/src/codex-compact.js";
import type { CodexCompactSettingsRuntime } from "../packages/pi-codex-compact/src/settings.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../packages/pi-codex-compact/src/settings.js";
import goal from "../packages/pi-goal/src/index.js";
import { denied, sandbox } from "./goal-compaction.setup.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Synthetic offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://offline-model.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-only" } })).toString("base64")}.x`;
const goalId = "synthetic-composition-goal";
const append = "\n\nSynthetic request-local guidance";
type Packet = { instructions: string; tools?: Array<{ name: string }>; input: Array<Record<string, unknown>> };
type GoalState = { goal: { id: string; status: string; iteration: number } | null; pendingAction?: unknown };
function goalState(source: SessionManager): GoalState | undefined {
  const entry = source
    .getBranch()
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === "goal-state");
  return entry?.type === "custom" ? (entry.data as GoalState) : undefined;
}

// Use the native Codex serializer AND parser with complete synthetic SSE, not
// fabricated assistant messages. High usage triggers native automatic compaction.
function sse(kind: "tool" | "reply" | "compact" | "complete", ordinal: number): Response {
  const item =
    kind === "compact"
      ? { type: "compaction", encrypted_content: `synthetic-opaque-${ordinal}` }
      : kind === "tool" || kind === "complete"
        ? {
            type: "function_call",
            id: `fc_${ordinal}`,
            call_id: `call_${ordinal}`,
            name: kind === "tool" ? "synthetic_tool" : "goal_complete",
            arguments:
              kind === "tool"
                ? "{}"
                : JSON.stringify({
                    goal_id: goalId,
                    summary: "The bounded synthetic exercise returned its expected tool result and is complete.",
                  }),
            status: "completed",
          }
        : {
            type: "message",
            id: `msg_${ordinal}`,
            role: "assistant",
            content: [{ type: "output_text", text: "Synthetic done." }],
          };
  const events =
    kind === "compact"
      ? [{ type: "response.output_item.done", output_index: 0, item }]
      : kind === "tool" || kind === "complete"
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "", status: "in_progress" },
            },
            { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
            { type: "response.output_item.done", output_index: 0, item },
          ]
        : [
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            {
              type: "response.content_part.added",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "" },
            },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Synthetic done." },
            { type: "response.output_item.done", output_index: 0, item },
          ];
  return new Response(
    [
      ...events,
      {
        type: "response.completed",
        response: {
          id: `resp_${ordinal}`,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: kind === "tool" ? 90_000 : 17,
            output_tokens: 4,
            total_tokens: kind === "tool" ? 90_004 : 21,
          },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

// Full-control SDK fixture: no filesystem resource discovery. Only registration
// maps are synthetic; native ExtensionRunner supplies contexts/runtime bindings.
async function fakeLoader(factories: ExtensionFactory[], directory: string) {
  const runtime = createExtensionRuntime();
  const events = createEventBus();
  const actions: string[] = [];
  const extensions: Extension[] = [];
  for (const [index, factory] of factories.entries()) {
    const path = join(directory, `inline-${index}`);
    const sourceInfo: Extension["sourceInfo"] = {
      path,
      source: "local",
      baseDir: directory,
      scope: "temporary",
      origin: "top-level",
    };
    const ext: Extension = {
      path,
      resolvedPath: path,
      sourceInfo,
      handlers: new Map(),
      tools: new Map(),
      messageRenderers: new Map(),
      entryRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    };
    type Handler = NonNullable<ReturnType<Extension["handlers"]["get"]>>[number];
    const api = {
      on(name: string, handler: Handler) {
        const list = ext.handlers.get(name) ?? [];
        list.push(handler);
        ext.handlers.set(name, list);
        return () => {};
      },
      registerCommand: ((name, command) => {
        ext.commands.set(name, { name, sourceInfo, ...command });
      }) as ExtensionAPI["registerCommand"],
      registerTool: ((definition) => {
        ext.tools.set(definition.name, { definition, sourceInfo } as unknown as NonNullable<
          ReturnType<Extension["tools"]["get"]>
        >);
        runtime.refreshTools();
      }) as ExtensionAPI["registerTool"],
      getActiveTools: () => runtime.getActiveTools(),
      getAllTools: () => runtime.getAllTools(),
      setActiveTools: (names: string[]) => runtime.setActiveTools(names),
      appendEntry: (type: string, data: unknown) => runtime.appendEntry(type, data),
      sendUserMessage: ((content, options) => {
        actions.push("sendUserMessage");
        return runtime.sendUserMessage(content, options);
      }) as ExtensionAPI["sendUserMessage"],
      sendMessage: ((message, options) => {
        actions.push("sendMessage");
        return runtime.sendMessage(message, options);
      }) as ExtensionAPI["sendMessage"],
      getSettings: () => runtime.getSettings(),
      events,
    } as unknown as ExtensionAPI;
    await factory(api);
    extensions.push(ext);
  }
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Synthetic canonical base envelope",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return { loader, actions };
}

type Control = "goal" | "goal-fold" | "ordinary" | "first-force" | "unwitnessed" | "malformed";
type Drift =
  | "auth-force"
  | "auth-base"
  | "auth-canonical"
  | "body-force"
  | "body-base"
  | "body-canonical"
  | "consent-canonical-to-effective"
  | "auth-canonical-to-effective"
  | "body-canonical-to-effective"
  | "fold-branch"
  | "fold-model"
  | "fold-provider"
  | "fold-prompt";
async function exercise(control: Control, drift?: Drift) {
  const directory = mkdtempSync(join(sandbox, "fixture-"));
  const realGoal = control === "goal" || control === "goal-fold";
  const boundedFold = control === "goal-fold";
  const remoteCheckpointCounts: number[] = [];
  const source = SessionManager.inMemory(directory);
  let target = false;
  let toolNext = false;
  let completeNext = false;
  let compacting = false;
  let transportRole = "ordinary";
  let targetRemoteStreams = 0;
  let mutateForce = () => {};
  const mutate = () => {
    if (drift?.endsWith("force") || drift?.endsWith("base")) mutateForce();
    else if (drift?.endsWith("canonical-to-effective")) {
      const ids = source.getBranch().map((entry) => entry.id);
      const checkpoint = source
        .getBranch()
        .reverse()
        .find((entry) => entry.type === "compaction");
      assert.ok(checkpoint?.type === "compaction" && checkpoint.systemMessage);
      assert.equal(getCurrentSystemPrompt(source.buildSessionContext().messages), preparations[0].canonical);
      assert.notEqual(preparations[0].canonical, preparations[0].effective);
      const systems = source.buildSessionContext().messages.filter((message) => message.role === "system");
      checkpoint.systemMessage.content = preparations[0].effective;
      // Native prompt preparation may have persisted additive base-only system
      // entries after the checkpoint. Change their existing strings in place as
      // well so this control becomes EXACTLY E/E, without new IDs or tool edits.
      for (const message of systems) {
        if (message !== checkpoint.systemMessage) message.content = "";
      }
      assert.equal(getCurrentSystemPrompt(source.buildSessionContext().messages), preparations[0].effective);
      assert.deepEqual(
        source.getBranch().map((entry) => entry.id),
        ids,
        "same-ID in-place mutation, not a branch append",
      );
    } else source.appendMessage({ role: "system", content: "Changed canonical envelope", timestamp: Date.now() });
  };
  // Hold the async seam until a separate microtask has changed the live state.
  const heldMutation = async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    mutate();
  };
  const requests: Array<{ target: boolean; kind: string; packet: Packet }> = [];
  const preparations: Array<{
    reason: string;
    canonical: string;
    effective: string;
    retained: AgentMessage[];
    activeGoal?: GoalState;
  }> = [];
  const errors: unknown[] = [];
  const notifications: string[] = [];
  const outcomes: Array<{ hasResult: boolean; aborted: boolean }> = [];
  const completions: boolean[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const packet = JSON.parse(typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8")) as Packet;
    const remote = packet.input.some((item) => item.type === "compaction_trigger");
    if (target && remote)
      remoteCheckpointCounts.push(source.getBranch().filter((entry) => entry.type === "compaction").length);
    const kind = remote ? "remote" : transportRole;
    requests.push({ target, kind, packet });
    assert.ok(requests.length < 30, "bounded synthetic execution");
    const responseKind = remote
      ? "compact"
      : kind === "ordinary" && toolNext
        ? "tool"
        : realGoal && target && completeNext && kind === "ordinary"
          ? "complete"
          : "reply";
    if (responseKind === "tool") toolNext = false;
    if (responseKind === "complete") completeNext = false;
    if (target && remote && drift?.startsWith("body")) {
      // Mutate while the successful response body is consumed, after transport.
      const response = sse(responseKind, requests.length);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(
        new ReadableStream({
          async start(controller) {
            await heldMutation();
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return sse(responseKind, requests.length);
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const actual: Provider = openaiCodexProvider();
  const provider: Provider = {
    ...actual,
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Synthetic only",
        resolve: async () => {
          if (target && compacting && drift?.startsWith("auth")) await heldMutation();
          return { auth: { apiKey, baseUrl: "https://resolved-offline.test/backend-api/codex" } };
        },
      },
    },
    stream: (m, context, options) => {
      transportRole = "remote";
      if (target && ++targetRemoteStreams === 2 && drift?.startsWith("fold")) {
        if (drift === "fold-branch")
          source.appendMessage({ role: "user", content: "Changed branch", timestamp: Date.now() });
        if (drift === "fold-model") {
          assert.ok(session.model);
          session.model.headers = { ...session.model.headers, "X-Profile": "changed" };
        }
        if (drift === "fold-provider") {
          const registered = runtime.getProvider(model.provider);
          assert.ok(registered);
          registered.stream = () => {
            throw new Error("Retired provider must not run");
          };
        }
        if (drift === "fold-prompt") {
          const checkpoint = source
            .getBranch()
            .filter((entry) => entry.type === "compaction")
            .at(-1);
          assert.ok(checkpoint?.systemMessage);
          checkpoint.systemMessage.content = "Changed canonical prompt";
        }
      }
      return actual.stream(m, context, {
        ...options,
        transport: "sse",
        fetch: options?.fetch ?? fetch,
      } as typeof options);
    },
    streamSimple: (m, context, options) => {
      transportRole = options?.sessionId === source.getSessionId() ? "ordinary" : "native";
      return actual.streamSimple(m, context, { ...options, transport: "sse", fetch: options?.fetch ?? fetch });
    },
  };
  runtime.registerNativeProvider(provider);
  const settings = SettingsManager.inMemory({
    defaultProvider: model.provider,
    defaultModel: model.id,
    defaultTools: [],
    compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 100 },
    retry: { enabled: false },
    cacheWarming: "off",
    transport: "sse",
    enableInstallTelemetry: false,
  });
  const extensionSettings: CodexCompactSettingsRuntime = {
    get: () => ({
      kind: "missing",
      path: join(directory, "compact.json"),
      document: {},
      settings: {
        ...DEFAULT_CODEX_COMPACT_SETTINGS,
        allowCanonicalHistory: !(target && drift?.startsWith("consent")),
        maxRetries: 0,
      },
    }),
    reload: async () => extensionSettings.get(),
    update: async () => {
      throw new Error("No settings writes");
    },
    flush: async () => {},
  };
  const observer: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) =>
      target && !realGoal && control !== "ordinary" ? { systemPrompt: event.systemPrompt + append } : undefined,
    );
    pi.on("session_before_compact", (event, ctx) => {
      compacting = true;
      if (!target) return;
      const projection = buildSessionProjection(event.branchEntries, event.branchEntries.at(-1)?.id ?? null);
      const kept = projection.entries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
      preparations.push({
        reason: event.reason,
        canonical: getCurrentSystemPrompt(source.buildSessionContext().messages),
        effective: ctx.getSystemPrompt(),
        activeGoal: goalState(source),
        retained: projection.entries
          .slice(kept)
          .flatMap((entry) => entry.messages)
          .filter((message) => message.role !== "system"),
      });
    });
  };
  const goalSettings = join(directory, "goal.json");
  if (realGoal)
    writeFileSync(
      goalSettings,
      JSON.stringify({ toolVisibility: "always", experimental: { goals: false }, rpc: { enabled: false } }),
    );
  const compactFactory = createCodexCompactExtension({ settingsRuntime: extensionSettings, fetch });
  const compactWithObservationControl: ExtensionFactory = (pi) => {
    // Test seam only: omit or corrupt Compact's ordinary callback evidence.
    // Neither manual compaction nor a serializer-preview request is used.
    const api = new Proxy(pi, {
      get(original, key, receiver) {
        if (key !== "on") return Reflect.get(original, key, receiver);
        return ((name: string, handler: NonNullable<ReturnType<Extension["handlers"]["get"]>>[number]) => {
          if (name === "before_provider_request" && (control === "unwitnessed" || control === "malformed")) {
            return pi.on("before_provider_request", (event, ctx) => {
              if (target && control === "unwitnessed") return;
              return handler(
                target ? { ...event, payload: { ...(event.payload as object), instructions: 42 } } : event,
                ctx,
              ) as never;
            });
          }
          return pi.on(name as never, handler);
        }) as ExtensionAPI["on"];
      },
    });
    compactFactory(api);
  };
  const { loader, actions } = await fakeLoader(
    [
      observer,
      ...(realGoal ? [(pi: ExtensionAPI) => goal(pi, { settingsPath: goalSettings })] : []),
      compactWithObservationControl,
    ],
    directory,
  );
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    settingsManager: settings,
    sessionManager: source,
    resourceLoader: loader,
    customTools: [
      {
        name: "synthetic_tool",
        label: "Synthetic",
        description: "Return text without I/O",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [
            {
              type: "text",
              text: `UNIQUE_SYNTHETIC_TOOL_TAIL ${"tail result ".repeat(target && boundedFold ? 23_000 : 150)}`,
            },
          ],
          details: {},
        }),
      },
    ],
  });
  mutateForce = () => {
    vi.spyOn(session, "systemPrompt", "get").mockReturnValue(
      drift?.endsWith("base")
        ? getCurrentSystemPrompt(source.buildSessionContext().messages)
        : "Changed effective envelope",
    );
  };
  const bindings: Parameters<typeof session.bindExtensions>[0] = {
    mode: drift?.startsWith("consent") ? "tui" : "rpc",
    uiContext: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: () => {},
      confirm: async () => {
        assert.ok(target && drift?.startsWith("consent"), "only the controlled consent case may ask");
        await heldMutation();
        return true;
      },
    } as unknown as ExtensionUIContext,
    onError: (error) => errors.push(error),
  };
  await session.bindExtensions(bindings);
  if (!realGoal) session.setActiveToolsByName(["synthetic_tool"]);
  assert.ok(session.getActiveToolNames().includes("synthetic_tool"));
  session.subscribe((event) => {
    if (event.type === "compaction_end") {
      if (target) outcomes.push({ hasResult: !!event.result, aborted: event.aborted });
      compacting = false;
    }
    if (target && event.type === "tool_execution_end" && event.toolName === "goal_complete")
      completions.push(!event.isError);
  });
  const checkpoints = () => source.getBranch().filter((entry) => entry.type === "compaction");
  const checkpoint = () => parseCheckpointDetails(checkpoints().at(-1)?.details);
  const fill = async (large = false) => {
    await session.prompt(`MEANINGFUL_SYNTHETIC_PREFIX ${"synthetic older text ".repeat(large ? 4000 : 1200)}`);
    await session.prompt(`Meaningful recent user tail ${"synthetic tail ".repeat(300)}`);
  };
  const trigger = async () => {
    settings.applyOverrides({ compaction: { enabled: true } });
    toolNext = true;
    await session.prompt("Execute synthetic tool then finish.");
  };
  try {
    if (control !== "first-force") {
      await fill();
      await trigger();
      assert.equal(checkpoints().length, 1);
      assert.ok(checkpoint(), "bootstrap itself uses automatic remote compaction");
      settings.applyOverrides({ compaction: { enabled: false } });
    }
    await fill(boundedFold);
    if (realGoal) {
      const now = Date.now();
      source.appendCustomEntry("goal-state", {
        goal: {
          id: goalId,
          text: "Return synthetic tool result and complete this bounded exercise.",
          status: "active",
          iteration: 9,
          startedAt: now,
          updatedAt: now,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          activeStartedAt: now,
          baselineTokens: source
            .getBranch()
            .reduce(
              (total, entry) =>
                total +
                (entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage.totalTokens : 0),
              0,
            ),
          automaticModelTurns: 0,
          toolFreeRepeatCount: 0,
        },
      });
      await session.bindExtensions(bindings);
      assert.equal(goalState(source)?.goal?.iteration, 9);
      assert.equal(goalState(source)?.pendingAction, undefined);
      completeNext = true;
    }
    target = true;
    const before = checkpoint();
    const beforeCount = checkpoints().length;
    await trigger();
    const targetRequests = requests.filter((request) => request.target);
    assert.equal(preparations.length, 1);
    assert.equal(preparations[0].reason, "threshold", "must be native automatic, never manual compact");
    assert.deepEqual(errors, []);
    assert.equal(source.getSessionFile(), undefined);
    const ordinary = targetRequests.filter((request) => request.kind === "ordinary");
    const remote = targetRequests.filter((request) => request.kind === "remote");
    assert.equal(ordinary.length, 2, "ordinary continuation is not suppressed after a cancelled compaction");
    assert.equal(
      targetRequests.filter((request) => request.kind === "native").length,
      0,
      "never native fallback over opaque history",
    );
    if (drift || control === "unwitnessed" || control === "malformed") {
      assert.equal(remote.length, drift?.startsWith("body") || drift?.startsWith("fold") ? 1 : 0);
      if (drift?.startsWith("fold"))
        assert.equal(targetRemoteStreams, 2, "second fold observes drift before its transport");
      assert.equal(checkpoints().length, beforeCount, "no stale compaction publication");
      assert.deepEqual(checkpoint(), before);
      assert.deepEqual(outcomes, [{ hasResult: false, aborted: true }]);
      if (!drift?.endsWith("canonical") && !drift?.startsWith("fold")) {
        assert.ok(
          notifications.some((message) =>
            /\[loadout_mismatch\](?: Last stage: .+ See \/codex-compact diagnostics\.)?$/.test(message),
          ),
        );
      }
    } else {
      assert.equal(remote.length, boundedFold ? 2 : 1);
      assert.deepEqual(
        remoteCheckpointCounts,
        remote.map(() => beforeCount),
        "no intermediate checkpoint publication",
      );
      assert.equal(checkpoints().length, beforeCount + 1);
      const after = checkpoint();
      assert.ok(after);
      assert.notEqual(after.checkpointId, before?.checkpointId);
      assert.notDeepEqual(after.replacementHistory.at(-1), before?.replacementHistory.at(-1));
      assert.ok(projectCheckpointContext(source.buildSessionContext().messages, after, "full"));
      assert.deepEqual(outcomes, [{ hasResult: true, aborted: false }]);
      const prep = preparations[0];
      for (const request of remote) {
        assert.equal(request.packet.instructions, prep.canonical);
        assert.deepEqual(request.packet.tools, remote[0].packet.tools);
      }
      const remoteInput = remote.flatMap((request) => request.packet.input);
      assert.ok(JSON.stringify(remote[0].packet.input).includes("MEANINGFUL_SYNTHETIC_PREFIX"));
      assert.equal(remote[0].packet.input.filter((item) => item.type === "compaction").length, before ? 1 : 0);
      const retainedResult = prep.retained.find((message) => message.role === "toolResult");
      assert.ok(retainedResult?.role === "toolResult");
      const exactResult = retainedResult.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      assert.deepEqual(
        remoteInput.filter((item) => item.type === "function_call_output").map((item) => item.output),
        [exactResult],
      );
      assert.equal(
        JSON.stringify(remoteInput).split("UNIQUE_SYNTHETIC_TOOL_TAIL").length - 1,
        1,
        "the exact retained tool result is covered once by full V1 compaction",
      );
      assert.equal(
        JSON.stringify(ordinary[1].packet.input).split("UNIQUE_SYNTHETIC_TOOL_TAIL").length - 1,
        0,
        "V1 covers the retained tail; do not replay it again beside its new opaque item",
      );
      assert.equal(ordinary[1].packet.input.filter((item) => item.type === "compaction").length, 1);
      if (boundedFold) {
        const finalOpaque = after.replacementHistory.find((item) => item.type === "compaction");
        assert.deepEqual(
          ordinary[1].packet.input.find((item) => item.type === "compaction"),
          finalOpaque,
        );
        assert.notDeepEqual(
          remote[1].packet.input.find((item) => item.type === "compaction"),
          finalOpaque,
        );
      }
      if (control !== "ordinary") {
        assert.notEqual(prep.canonical, prep.effective);
        assert.ok(ordinary.every((request) => request.packet.instructions === prep.effective));
        assert.ok(!JSON.stringify(after).includes(realGoal ? goalId : append));
      }
      if (realGoal) {
        assert.equal(prep.activeGoal?.goal?.id, goalId);
        assert.equal(prep.activeGoal?.goal?.status, "active");
        assert.equal(prep.activeGoal?.goal?.iteration, 9);
        assert.equal(prep.activeGoal?.pendingAction, undefined);
        assert.ok(prep.effective.includes("Active /goal:") && prep.effective.includes(goalId));
        assert.ok(!prep.canonical.includes(goalId));
        assert.ok(ordinary.every((request) => request.packet.tools?.some((tool) => tool.name === "goal_complete")));
        assert.deepEqual(completions, [true]);
        assert.equal(goalState(source)?.goal, null);
        assert.ok(!getCurrentSystemPrompt(source.buildSessionContext().messages).includes(goalId));
        assert.equal(session.isIdle, true);
        assert.deepEqual(actions, [], "actual goal_complete terminates without synthetic suppression or self-queueing");
      }
    }
    assert.deepEqual(denied, { fetch: 0, websocket: 0, socket: 0, http: 0 });
  } finally {
    // A native rebind clears Goal's completion status timer without private APIs.
    if (realGoal) await session.bindExtensions(bindings);
    session.dispose();
  }
}

for (const control of ["goal", "goal-fold", "ordinary", "first-force", "unwitnessed", "malformed"] as const) {
  test(`automatic compaction composition: ${control}`, () => exercise(control), 20_000);
}
for (const drift of ["fold-branch", "fold-model", "fold-provider", "fold-prompt"] as const) {
  test(`automatic multi-fold cancels between stages: ${drift}`, () => exercise("goal-fold", drift), 20_000);
}
for (const drift of [
  "auth-force",
  "auth-base",
  "auth-canonical",
  "body-force",
  "body-base",
  "body-canonical",
  "consent-canonical-to-effective",
  "auth-canonical-to-effective",
  "body-canonical-to-effective",
] as const) {
  test(`automatic compaction rejects ${drift} drift`, () => exercise("goal", drift), 20_000);
}
