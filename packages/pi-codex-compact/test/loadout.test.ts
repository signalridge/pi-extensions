import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type Model,
  normalizeContext,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  buildSessionContext,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import type { JsonObject } from "../src/protocol.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";
import { ToolStateTracker } from "../src/tool-state.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline Codex test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.x`;

function sseResponse(compact: boolean): Response {
  const item = compact
    ? { type: "compaction", encrypted_content: "offline-opaque" }
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
    [...events, { type: "response.completed", response: { status: "completed", output: [item] } }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

for (const incremental of [true, false]) {
  test(`native provider synthetic tool additions retain exact wire proof (incremental=${incremental})`, async () => {
    const provider = openaiCodexProvider();
    const read = {
      name: "read",
      description: "Read synthetic files",
      parameters: Type.Object({ path: Type.String() }),
    };
    const todo = {
      name: "todo",
      description: "Synthetic checklist",
      parameters: Type.Object({ title: Type.String() }),
    };
    const recorded = [read, todo];
    const context = normalizeContext({
      messages: [
        { role: "system", content: "Synthetic initial system.", toolsAdded: [read], timestamp: 1 },
        { role: "user", content: "Synthetic first message.", timestamp: 2 },
        { role: "system", content: "", toolsAdded: [todo], timestamp: 3 },
        { role: "user", content: "Synthetic second message.", timestamp: 4 },
      ],
    });
    const syntheticModel = {
      ...model,
      compat: {
        supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: incremental,
        supportsToolSearch: incremental,
      },
    };
    let fetchAttempts = 0;
    let payload: JsonObject | undefined;
    const stream = provider.stream(syntheticModel, context, {
      apiKey,
      transport: "sse",
      maxRetries: 0,
      fetch: async () => {
        fetchAttempts += 1;
        throw new Error("Offline probe must abort before transport");
      },
      onPayload(value) {
        payload = structuredClone(value) as JsonObject;
        throw new DOMException("Synthetic payload captured", "AbortError");
      },
    });
    for await (const _event of stream) {
      /* Drain the provider's handled abort. */
    }
    assert.ok(payload);
    assert.equal(fetchAttempts, 0);
    const top = payload.tools ?? [];
    const groups = payload.input.filter((item: JsonObject) => item.type === "additional_tools");
    const layout = {
      top: top.map((tool: JsonObject) => tool.name),
      groups: groups.map((group: JsonObject) => group.tools.map((tool: JsonObject) => tool.name)),
    };
    if (incremental) {
      // Pi 1.0.4 keeps the initial read tool at the top level; newer Codex
      // serializers emit both declarations as ordered additional_tools groups.
      assert.ok(
        JSON.stringify(layout) === JSON.stringify({ top: ["read"], groups: [["todo"]] }) ||
          JSON.stringify(layout) === JSON.stringify({ top: [], groups: [["read"], ["todo"]] }),
        "only the two known incremental wire layouts are supported by this fixture",
      );
      for (const group of groups) assert.equal(group.role, "developer");
    } else {
      assert.deepEqual(layout, { top: ["read", "todo"], groups: [] });
    }
    const tracker = new ToolStateTracker();
    const owner = {};
    tracker.prepare(owner, "synthetic", recorded, recorded);
    assert.equal(tracker.matches(owner, "synthetic", recorded, recorded), true);
    tracker.observe(owner, "synthetic", recorded, recorded, payload);
    assert.equal(tracker.matches(owner, "synthetic", recorded, recorded), true);
    const validate = tracker.payloadValidator(owner, "synthetic");
    assert.ok(validate);
    assert.equal(validate(payload), true);
    if (incremental) {
      const flat = structuredClone(payload);
      flat.tools = [...top, ...groups.flatMap((group: JsonObject) => group.tools)];
      flat.input = flat.input.filter((item: JsonObject) => item.type !== "additional_tools");
      assert.equal(validate(flat), false, "the same effective tool set is not the same serialized proof");
    }
  });
}

/** Real SDK and Codex serializer, isolated credentials, and a fully stubbed transport. */
async function sdkFixture(mode: "on" | "only" = "on", goalPhase?: "before" | "auth" | "flight", additive = false) {
  const sessionModel = additive
    ? {
        ...model,
        compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true },
      }
    : model;
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-compact-loadout-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live HTTP request"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("Unexpected live WebSocket request");
  });
  const requests: JsonObject[] = [];
  let appendGoal = () => {};
  let compacting = false;
  let compactionAuth = 0;
  let promptSection: string | undefined;
  let todoTool: ToolDefinition | undefined;
  const preparations: Array<{ firstKeptEntryId: string; tokensBefore: number; sourceIds: string[] }> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const payload = JSON.parse(
      typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8"),
    ) as JsonObject;
    requests.push(payload);
    assert.ok(Array.isArray(payload.input));
    const compact = payload.input.some((item: JsonObject) => item.type === "compaction_trigger");
    if (compact && goalPhase === "flight") appendGoal();
    return sseResponse(compact);
  };
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let cachedRequest: Parameters<ModelRuntime["streamSimple"]> | undefined;
    const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
    vi.spyOn(modelRuntime, "streamSimple").mockImplementation((...args) => {
      cachedRequest = args;
      return streamSimple(...args);
    });
    let registerTool: ((tool: ToolDefinition) => void) | undefined;
    const editableTool: ToolDefinition = {
      name: "inspect",
      label: "Inspect",
      description: "Inspect an offline path",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "Offline test" }], details: {} }),
    };
    const actual = openaiCodexProvider();
    const provider: Provider = {
      ...actual,
      auth: {
        apiKey: {
          name: "Offline test",
          resolve: async () => {
            if (compacting) {
              compactionAuth += 1;
              if (goalPhase === "auth") appendGoal();
            }
            return { auth: { apiKey } };
          },
        },
      },
      getModels: () => [sessionModel],
      stream: (requestModel, context, options) =>
        actual.stream(requestModel, context, { ...options, transport: "sse", fetch: options?.fetch ?? fetch }),
      streamSimple: (requestModel, context, options) =>
        actual.streamSimple(requestModel, context, { ...options, transport: "sse", fetch: options?.fetch ?? fetch }),
    };
    modelRuntime.registerNativeProvider(provider);
    const compactSettings = createCodexCompactSettingsRuntime(join(directory, "pi-codex-compact.json"));
    await compactSettings.update({ allowCanonicalHistory: true });
    const open = async (manager: SessionManager) => {
      const settingsManager = SettingsManager.inMemory({
        defaultTools: additive ? ["read"] : ["read", "codemode", "inspect"],
        compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 6 },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: additive ? "Synthetic fixed additive prompt." : undefined,
        extensionFactories: [
          // Synthetic earlier extension uses only the public append API, not Goal source.
          (pi) => {
            if (additive)
              pi.on("before_agent_start", (event) => {
                // Collapse the request to its resolved head without hiding prompt
                // drift behind an unrelated fixed string.
                event.systemPromptOptions.forceSystemPrompt = event.systemPrompt;
              });
            appendGoal = () => {
              const before = buildSessionContext(manager.getBranch(), manager.getLeafId()).messages;
              pi.appendEntry("goal-state", { synthetic: true });
              pi.appendEntry("goal-state", { synthetic: true });
              assert.deepEqual(buildSessionContext(manager.getBranch(), manager.getLeafId()).messages, before);
            };
            pi.on("session_before_compact", (event) => {
              compacting = true;
              preparations.push({
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
                sourceIds: event.branchEntries.map((entry) => entry.id),
              });
              if (goalPhase === "before") appendGoal();
            });
            pi.on("session_compact", () => {
              compacting = false;
            });
          },
          createCodemodeExtension({ mode }),
          (pi) => {
            registerTool = (tool) => pi.registerTool(tool);
            if (!additive) pi.registerTool(editableTool);
            if (todoTool) pi.registerTool(todoTool);
          },
          createCodexCompactExtension({
            settingsRuntime: compactSettings,
            fetch,
          }),
        ],
      });
      if (additive) {
        vi.spyOn(resourceLoader, "getAppendSystemPrompt").mockImplementation(() =>
          promptSection === undefined ? [] : [promptSection],
        );
      }
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        model: sessionModel,
        thinkingLevel: "off",
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: manager,
      });
      try {
        await session.bindExtensions({});
        return session;
      } catch (error) {
        session.dispose();
        throw error;
      }
    };
    return {
      directory,
      requests,
      preparations,
      compactionAuth: () => compactionAuth,
      open,
      replayCachedRequest: async () => {
        assert.ok(cachedRequest);
        const [cachedModel, cachedContext, options] = cachedRequest;
        // CacheWarmer reuses the normal context and provider callbacks, but owns
        // a fresh abort signal. Exercise that actual SDK callback path offline.
        for await (const event of modelRuntime.streamSimple(cachedModel, cachedContext, {
          ...options,
          signal: new AbortController().signal,
        })) {
          assert.notEqual(event.type, "error", JSON.stringify(event));
        }
      },
      setPromptSection: (value: string | undefined) => {
        promptSection = value;
      },
      addTool: () => {
        assert.ok(registerTool);
        todoTool = {
          name: "todo",
          label: "Todo",
          description: "Synthetic additive checklist",
          parameters: Type.Object({ title: Type.String() }),
          execute: async () => ({ content: [{ type: "text", text: "Offline checklist" }], details: {} }),
        };
        registerTool(todoTool);
      },
      changeTodo: (drift: "description" | "schema") => {
        assert.ok(registerTool && todoTool);
        todoTool = {
          ...todoTool,
          ...(drift === "description"
            ? { description: "Unsent same-name checklist description" }
            : { parameters: Type.Object({ title: Type.String(), completed: Type.Boolean() }) }),
        };
        registerTool(todoTool);
      },
      changeDescription: () => {
        assert.ok(registerTool);
        registerTool({ ...editableTool, description: "A newly registered, unsent inspect description" });
      },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("SDK codemode request → remote compaction → persisted reload → opaque replay", async () => {
  const fixture = await sdkFixture();
  const manager = SessionManager.create(fixture.directory, fixture.directory);
  let session: AgentSession | undefined;
  try {
    session = await fixture.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    assert.equal(
      session.getLastAssistantText(),
      "Done.",
      JSON.stringify(session.messages.filter((message) => message.role === "assistant")),
    );
    assert.equal(fixture.requests.length, 2);
    const recordedRead = getCurrentTools(manager.buildSessionContext().messages).find((tool) => tool.name === "read");
    const rawRead = session.getAllTools().find((tool) => tool.name === "read");
    assert.ok(recordedRead && rawRead);
    assert.notEqual(recordedRead.description, rawRead.description);
    const result = await session.compact();
    const details = parseCheckpointDetails(result.details);
    assert.ok(details, "SDK must select Remote V2, not native summary fallback");
    const compactPayload = fixture.requests.at(-1);
    assert.ok(compactPayload && Array.isArray(compactPayload.input));
    assert.equal(compactPayload.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    assert.ok(Array.isArray(compactPayload.tools));
    assert.equal(
      compactPayload.tools.find((tool: JsonObject) => tool.name === "read")?.description,
      recordedRead.description,
    );
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    session.dispose();
    session = await fixture.open(SessionManager.open(sessionFile));
    await session.prompt("Continue after reload.");
    assert.equal(session.getLastAssistantText(), "Done.");
    const replay = fixture.requests.at(-1);
    assert.ok(replay && Array.isArray(replay.input));
    assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 0);
    assert.doesNotMatch(JSON.stringify(replay.input), /PI_CODEX_REMOTE_CHECKPOINT/);
    assert.match(JSON.stringify(replay.input), /Continue after reload/);

    // The resumed ordinary request establishes fresh evidence for repeated
    // compaction; the older opaque item must not be resurrected as another item.
    const repeated = await session.compact();
    assert.ok(parseCheckpointDetails(repeated.details));
    const repeatedPayload = fixture.requests.at(-1);
    assert.ok(repeatedPayload && Array.isArray(repeatedPayload.input));
    assert.equal(repeatedPayload.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.equal(repeatedPayload.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    await session.prompt("Continue after repeated compaction.");
    const repeatedReplay = fixture.requests.at(-1);
    assert.ok(repeatedReplay && Array.isArray(repeatedReplay.input));
    assert.equal(repeatedReplay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.doesNotMatch(JSON.stringify(repeatedReplay.input), /PI_CODEX_REMOTE_CHECKPOINT/);
  } finally {
    session?.dispose();
    fixture.cleanup();
  }
});

function wireSurfaces(payload: JsonObject) {
  return {
    tools: payload.tools,
    groups: payload.input.filter((item: JsonObject) => item.type === "additional_tools"),
    instructions: payload.instructions,
    prompt: payload.input.filter(
      (item: JsonObject) => item.type !== "additional_tools" && (item.role === "system" || item.role === "developer"),
    ),
  };
}

for (const drift of ["none", "membership", "description", "schema", "prompt", "fingerprint", "anchor"] as const) {
  test(`SDK prior checkpoint → persisted additive tool → ordinary request → repeated compaction (drift=${drift})`, async () => {
    const fixture = await sdkFixture("on", undefined, true);
    const manager = SessionManager.create(fixture.directory, fixture.directory);
    let session: AgentSession | undefined;
    try {
      session = await fixture.open(manager);
      await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
      await session.prompt("Keep this recent task.");
      const first = await session.compact();
      const firstDetails = parseCheckpointDetails(first.details);
      assert.ok(firstDetails);
      const firstHistory = structuredClone(manager.getEntries());
      fixture.addTool();
      session.setActiveToolsByName(["read", "todo"]);
      const omitted = manager.appendMessage({ role: "user", content: "OMITTED_ADDITIVE_CANARY", timestamp: 101 });
      const replaced = manager.appendMessage({ role: "user", content: "STALE_ADDITIVE_CANARY", timestamp: 102 });
      manager.appendContextEdit(omitted, null);
      manager.appendContextEdit(replaced, { content: "REPLACEMENT_ADDITIVE_CANARY" });
      assert.doesNotMatch(JSON.stringify(manager.buildSessionContext().messages), /OMITTED_ADDITIVE|STALE_ADDITIVE/);
      await session.prompt("Establish unchanged additive declarations after the checkpoint.");
      assert.deepEqual(
        getCurrentTools(manager.buildSessionContext().messages).map((tool) => tool.name),
        ["read", "todo"],
      );
      assert.deepEqual(
        manager
          .buildSessionContext()
          .messages.filter((message) => message.role === "system")
          .map((message) => message.toolsAdded?.map((tool) => tool.name)),
        [["read"], ["todo"]],
        "canonical history must retain separate additive declarations",
      );
      const ordinary = fixture.requests.at(-1);
      assert.ok(ordinary);
      assert.doesNotMatch(JSON.stringify(ordinary), /OMITTED_ADDITIVE_CANARY|STALE_ADDITIVE_CANARY/);
      assert.match(JSON.stringify(ordinary), /REPLACEMENT_ADDITIVE_CANARY/);
      const declarations = wireSurfaces(ordinary);
      const effective = [
        ...(declarations.tools ?? []),
        ...declarations.groups.flatMap((group: JsonObject) => group.tools),
      ];
      assert.deepEqual(
        effective.map((tool: JsonObject) => tool.name),
        ["read", "todo"],
      );
      assert.equal(ordinary.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
      const requestsBefore = fixture.requests.length;
      if (drift === "membership") session.setActiveToolsByName(["read"]);
      if (drift === "description" || drift === "schema") {
        fixture.changeTodo(drift);
        const recorded = getCurrentTools(manager.buildSessionContext().messages).find((tool) => tool.name === "todo");
        const live = session.getAllTools().find((tool) => tool.name === "todo");
        assert.ok(recorded && live);
        assert.deepEqual(session.getActiveToolNames(), ["read", "todo"], "membership alone must not admit drift");
        assert.notDeepEqual(
          live[drift === "schema" ? "parameters" : "description"],
          recorded[drift === "schema" ? "parameters" : "description"],
        );
        assert.equal(session.systemPrompt, getCurrentSystemPrompt(manager.buildSessionContext().messages));
      }
      if (drift === "prompt") {
        const previousPrompt = session.systemPrompt;
        vi.spyOn(session, "systemPrompt", "get").mockReturnValue(`${previousPrompt}\nUNSENT_PROMPT_CANARY`);
        assert.notEqual(session.systemPrompt, getCurrentSystemPrompt(manager.buildSessionContext().messages));
      }
      if (drift === "fingerprint" || drift === "anchor") {
        const corrupted = structuredClone(firstDetails);
        assert.ok(corrupted.keptMessageFingerprints.length > 0, "exercise a retained lineage, not an empty proof");
        if (drift === "fingerprint") corrupted.keptMessageFingerprints[0] = "0".repeat(64);
        assert.ok(parseCheckpointDetails(corrupted), "well-formed details must still fail lineage validation");
        manager.appendCompaction(
          drift === "anchor" ? `${first.summary} CORRUPTED_ANCHOR` : first.summary,
          first.firstKeptEntryId,
          first.tokensBefore,
          corrupted,
          true,
        );
        manager.appendMessage({ role: "user", content: "Synthetic task after corrupted checkpoint.", timestamp: 103 });
      }
      const before = structuredClone(manager.getEntries());
      if (drift !== "none") {
        const sessionFile = manager.getSessionFile();
        assert.ok(sessionFile);
        const diskBefore = readFileSync(sessionFile, "utf8");
        await assert.rejects(session.compact(), /cancelled/i);
        assert.equal(fixture.requests.length, requestsBefore, "unsent drift/corruption must not reach transport");
        assert.deepEqual(manager.getEntries(), before, "retain the prior opaque checkpoint");
        assert.equal(readFileSync(sessionFile, "utf8"), diskBefore, "cancellation must not rewrite persisted history");
      } else {
        const repeated = await session.compact();
        assert.ok(
          parseCheckpointDetails(repeated.details),
          "canonical resolved system state must reproduce ordinary wire proof",
        );
        assert.equal(fixture.requests.length, requestsBefore + 1, "one Remote V2 request, no native fallback");
        const remote = fixture.requests.at(-1);
        assert.ok(remote);
        assert.deepEqual(
          wireSurfaces(remote),
          declarations,
          "exact prompt and declaration surfaces, not just membership",
        );
        assert.doesNotMatch(JSON.stringify(remote), /OMITTED_ADDITIVE_CANARY|STALE_ADDITIVE_CANARY/);
        assert.match(JSON.stringify(remote), /REPLACEMENT_ADDITIVE_CANARY/);
        assert.equal(remote.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
        assert.equal(remote.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
        const persisted = structuredClone(manager.getEntries());
        const sessionFile = manager.getSessionFile();
        assert.ok(sessionFile);
        session.dispose();
        const reopened = SessionManager.open(sessionFile);
        assert.deepEqual(
          reopened.getEntries(),
          persisted,
          "repeated checkpoint and append-only edits survive disk reload",
        );
        session = await fixture.open(reopened);
        await session.prompt("Replay repeated additive checkpoint after reload.");
        assert.equal(session.getLastAssistantText(), "Done.");
        const replay = fixture.requests.at(-1);
        assert.ok(replay);
        assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
        assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 0);
        assert.doesNotMatch(
          JSON.stringify(replay),
          /PI_CODEX_REMOTE_CHECKPOINT|OMITTED_ADDITIVE_CANARY|STALE_ADDITIVE_CANARY/,
        );
        assert.match(JSON.stringify(replay), /REPLACEMENT_ADDITIVE_CANARY/);
        assert.deepEqual(
          parseCheckpointDetails(reopened.getEntries().findLast((entry) => entry.type === "compaction")?.details),
          parseCheckpointDetails(repeated.details),
        );
      }
      assert.deepEqual(manager.getEntries().slice(0, firstHistory.length), firstHistory, "never rewrite prior history");
    } finally {
      session?.dispose();
      fixture.cleanup();
    }
  });
}

for (const section of ["replaced", "removed"] as const) {
  test(`SDK prior additive checkpoint resolves a ${section} named prompt section for repeated compaction`, async () => {
    const fixture = await sdkFixture("on", undefined, true);
    const manager = SessionManager.create(fixture.directory, fixture.directory);
    let session: AgentSession | undefined;
    try {
      fixture.setPromptSection("STALE_SECTION_CANARY");
      session = await fixture.open(manager);
      await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
      await session.prompt("Keep this recent task.");
      assert.match(getCurrentSystemPrompt(manager.buildSessionContext().messages), /STALE_SECTION_CANARY/);
      const first = await session.compact();
      assert.ok(parseCheckpointDetails(first.details));
      fixture.setPromptSection(section === "replaced" ? "REPLACEMENT_SECTION_CANARY" : undefined);
      fixture.addTool();
      session.setActiveToolsByName(["read", "todo"]);
      await session.prompt("Establish fresh additive evidence for the changed prompt section.");
      const transcript = manager.buildSessionContext().messages;
      const patches = transcript.filter((message) => message.role === "system");
      assert.ok(patches.some((message) => message.sections?.addendum?.includes("STALE_SECTION_CANARY")));
      assert.equal(
        patches.at(-1)?.sections?.addendum,
        section === "replaced" ? "<addendum>\nREPLACEMENT_SECTION_CANARY\n</addendum>" : null,
        "use the public structured transcript's named replacement/removal, not provider compat mutation",
      );
      const resolved = getCurrentSystemPrompt(transcript);
      assert.equal(session.systemPrompt, resolved);
      assert.doesNotMatch(resolved, /STALE_SECTION_CANARY/);
      if (section === "replaced") assert.match(resolved, /REPLACEMENT_SECTION_CANARY/);
      const ordinary = fixture.requests.at(-1);
      assert.ok(ordinary);
      const ordinarySurfaces = wireSurfaces(ordinary);
      assert.doesNotMatch(JSON.stringify(ordinarySurfaces), /STALE_SECTION_CANARY/);
      if (section === "replaced") assert.match(JSON.stringify(ordinarySurfaces), /REPLACEMENT_SECTION_CANARY/);
      const before = fixture.requests.length;
      const repeated = await session.compact();
      assert.ok(parseCheckpointDetails(repeated.details));
      assert.equal(fixture.requests.length, before + 1);
      const remote = fixture.requests.at(-1);
      assert.ok(remote);
      assert.deepEqual(wireSurfaces(remote), ordinarySurfaces, "resolved prompt as well as exact tool declarations");
      assert.doesNotMatch(JSON.stringify(wireSurfaces(remote)), /STALE_SECTION_CANARY/);
      assert.equal(remote.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
      assert.equal(remote.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    } finally {
      session?.dispose();
      fixture.cleanup();
    }
  });
}

for (const phase of ["before", "auth", "flight"] as const) {
  test(`SDK Goal bookkeeping ${phase} compaction preserves remote checkpoint and preparation metadata`, async () => {
    const fixture = await sdkFixture("on", phase);
    const manager = SessionManager.create(fixture.directory, fixture.directory);
    let session: AgentSession | undefined;
    try {
      session = await fixture.open(manager);
      await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
      await session.prompt("Second task.");
      const requestsBefore = fixture.requests.length;
      const result = await session.compact();
      const details = parseCheckpointDetails(result.details);
      assert.ok(details, "Goal bookkeeping must not cancel before auth or fall back for loadout mismatch");
      assert.ok(fixture.compactionAuth() > 0);
      assert.equal(fixture.requests.length, requestsBefore + 1, "one remote request, no native fallback");
      const preparation = fixture.preparations.at(-1);
      assert.ok(preparation);
      assert.equal(result.firstKeptEntryId, preparation.firstKeptEntryId);
      assert.equal(result.tokensBefore, preparation.tokensBefore);
      const branch = manager.getBranch();
      assert.deepEqual(
        branch.slice(0, preparation.sourceIds.length).map((entry) => entry.id),
        preparation.sourceIds,
      );
      const appended = branch.slice(preparation.sourceIds.length, -1);
      assert.equal(appended.length, 2);
      assert.ok(appended.every((entry) => entry.type === "custom" && entry.customType === "goal-state"));
      assert.equal(branch.at(-1)?.parentId, appended.at(-1)?.id);
      const committed = branch.at(-1);
      assert.ok(committed?.type === "compaction");
      assert.deepEqual(committed.details, result.details);
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      session.dispose();
      session = await fixture.open(SessionManager.open(sessionFile));
      await session.prompt("Continue after bookkeeping checkpoint reload.");
      const replay = fixture.requests.at(-1);
      assert.ok(replay);
      assert.equal(replay.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
      assert.doesNotMatch(JSON.stringify(replay), /goal-state|synthetic/);
      assert.equal(session.getLastAssistantText(), "Done.");
    } finally {
      session?.dispose();
      fixture.cleanup();
    }
  });
}

test("SDK codemode-only hidden declarations use native compaction, never restore hidden tools remotely", async () => {
  const fixture = await sdkFixture("only");
  let session: AgentSession | undefined;
  try {
    const manager = SessionManager.create(fixture.directory, fixture.directory);
    session = await fixture.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    const persisted = getCurrentTools(manager.buildSessionContext().messages);
    assert.ok(persisted.some((tool) => tool.name === "read"));
    assert.ok(Array.isArray(fixture.requests.at(-1)?.tools));
    assert.equal(
      fixture.requests.at(-1)?.tools.some((tool: JsonObject) => tool.name === "read"),
      false,
    );
    const result = await session.compact();
    assert.equal(parseCheckpointDetails(result.details), undefined);
    assert.equal(
      fixture.requests.some((request) => request.input.some((item: JsonObject) => item.type === "compaction_trigger")),
      false,
    );
    assert.equal(session.getLastAssistantText(), "Done.");
  } finally {
    session?.dispose();
    fixture.cleanup();
  }
});

for (const change of ["registry description", "reload"] as const) {
  test(`SDK cached provider callbacks cannot admit stale transformed tools after ${change}`, async () => {
    const fixture = await sdkFixture();
    let session: AgentSession | undefined;
    try {
      const manager = SessionManager.create(fixture.directory, fixture.directory);
      session = await fixture.open(manager);
      await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
      await session.prompt("Second task.");
      const recordedRead = getCurrentTools(manager.buildSessionContext().messages).find((tool) => tool.name === "read");
      const rawRead = session.getAllTools().find((tool) => tool.name === "read");
      assert.ok(recordedRead && rawRead);
      assert.notEqual(recordedRead.description, rawRead.description);
      if (change === "reload") {
        await session.reload();
      } else {
        const recordedInspect = getCurrentTools(manager.buildSessionContext().messages).find(
          (tool) => tool.name === "inspect",
        );
        assert.ok(recordedInspect);
        fixture.changeDescription();
        assert.equal(
          session.getAllTools().find((tool) => tool.name === "inspect")?.description,
          "A newly registered, unsent inspect description",
        );
        assert.equal(
          getCurrentTools(manager.buildSessionContext().messages).find((tool) => tool.name === "inspect")?.description,
          recordedInspect.description,
        );
        assert.equal(
          getCurrentTools(manager.buildSessionContext().messages).find((tool) => tool.name === "read")?.description,
          recordedRead.description,
        );
        assert.equal(
          session.systemPrompt,
          getCurrentSystemPrompt(manager.buildSessionContext().messages),
          "preserve prompt contributions so the tool-state guard, not a prompt mismatch, must reject the edit",
        );
      }
      await fixture.replayCachedRequest();
      const result = await session.compact();
      assert.equal(
        parseCheckpointDetails(result.details),
        undefined,
        "cached callbacks must not establish fresh proof",
      );
      assert.equal(
        fixture.requests.some((request) =>
          request.input.some((item: JsonObject) => item.type === "compaction_trigger"),
        ),
        false,
      );
      await session.prompt("Fresh normal preparation establishes current declarations.");
      const next = await session.compact();
      assert.ok(parseCheckpointDetails(next.details), "a fresh unchanged normal request still supports Remote V2");
    } finally {
      session?.dispose();
      fixture.cleanup();
    }
  });
}
