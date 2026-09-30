import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import sessionRecap from "../index.ts";

const api = "recap-provider-isolation-test";
const calls = [];
registerApiProvider({
  api,
  stream: () => {
    throw new Error("unexpected stream path");
  },
  streamSimple: (model, context) => {
    calls.push({ model, context });
    return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Safe recap." }] }) };
  },
});

test("independent recap provider receives conversation but no projected parent system instructions or tools", async () => {
  calls.length = 0;
  const manager = SessionManager.inMemory();
  const privateTool = {
    name: "private-parent-tool",
    description: "Private parent tool declaration",
    parameters: { type: "object", properties: {} },
  };
  manager.appendMessage({
    role: "system",
    content: "Private parent prompt",
    sections: { internal: "Private parent section" },
    toolsAdded: [privateTool],
    timestamp: 1,
  });
  const userId = manager.appendMessage({ role: "user", content: "Build a safe preview.", timestamp: 2 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "I inspected the preview." }],
    api: "anthropic-messages",
    provider: "parent-provider",
    model: "parent-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: 3,
  });
  manager.appendCompaction("The preview is ready for validation.", userId, 100);
  manager.appendMessage({
    role: "system",
    content: "Private follow-up instruction",
    toolsAdded: [{ ...privateTool, name: "private-follow-up-tool" }],
    timestamp: 4,
  });
  manager.appendCustomMessageEntry("preview-status", "Check the layout on mobile.", false);

  const projected = manager.buildSessionProjection();
  assert.equal(projected.messages.filter((message) => message.role === "system").length, 2);
  assert.equal(projected.messages[0].role, "system", "compaction retains a system snapshot");
  assert.equal(projected.messages[0].toolsAdded[0].name, "private-parent-tool");
  assert.equal(projected.messages.at(-2).toolsAdded[0].name, "private-follow-up-tool");

  const commands = new Map();
  const flags = new Map();
  sessionRecap({
    on() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  });
  flags.set("recap-allow-raw-history", true);
  flags.set("recap-model", "independent/isolated");
  const recapModel = {
    id: "isolated",
    name: "Independent recap model",
    api,
    provider: "independent",
    baseUrl: "http://localhost.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const widgets = [];
  await commands.get("recap").handler("", {
    mode: "rpc",
    hasUI: true,
    model: { ...recapModel, provider: "parent-provider" },
    modelRegistry: {
      find: (provider, model) => (provider === "independent" && model === "isolated" ? recapModel : undefined),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: manager,
    ui: {
      setStatus() {},
      setWidget(_key, content) {
        widgets.push(content);
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model.provider, "independent");
  assert.ok(!calls[0].context.systemPrompt, "the recap request must not set a system prompt");
  assert.deepEqual(
    calls[0].context.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "Build a safe preview." },
      { role: "assistant", content: [{ type: "text", text: "I inspected the preview." }] },
      { role: "user", content: [{ type: "text", text: "Check the layout on mobile." }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Broader session context:\nSession summary:\nThe preview is ready for validation.\n\n" +
              "The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
              "Start by stating the high-level task — what they are building or debugging, not " +
              "implementation details. Next: the concrete next step. Skip status reports and commit recaps.",
          },
        ],
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(calls[0].context),
    /Private parent|private-parent-tool|private-follow-up-tool|follow-up instruction/,
  );
  assert.deepEqual(widgets.at(-1), ["✦ recap", "Safe recap."]);
});

test("real Pi context redaction protects parent wire, but only explicit target consent sends raw recap history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-recap-privacy-"));
  const sourceId = `recap-privacy-${crypto.randomUUID()}`;
  let session;
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const parent = createFauxCore({ api: `${sourceId}-parent-api`, provider: `${sourceId}-parent` });
    const recap = createFauxCore({ api: `${sourceId}-recap-api`, provider: `${sourceId}-recap` });
    for (const faux of [parent, recap]) {
      registry.registerProvider(faux.provider, {
        api: faux.api,
        apiKey: "faux-test-key",
        baseUrl: faux === recap ? "https://registered.example" : "http://localhost.invalid",
        streamSimple: faux.streamSimple,
        models: faux.models.map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          baseUrl: faux === recap ? "https://registered.example" : model.baseUrl,
          reasoning: model.reasoning,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
      });
      registerApiProvider({ api: faux.api, stream: faux.stream, streamSimple: faux.streamSimple }, sourceId);
    }

    const parentWire = [];
    const recapWire = [];
    parent.setResponses([
      (context) => {
        parentWire.push(context);
        return fauxAssistantMessage(
          "I inspected the test scenario, confirmed the parent request redacts its private token, and identified the next verification step for the integration while preserving the session history and its task framing.",
        );
      },
    ]);
    recap.setResponses([
      (context, options, _state, model) => {
        recapWire.push({ context, options, model });
        return fauxAssistantMessage("Safe recap.");
      },
    ]);

    let redactions = 0;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      additionalExtensionPaths: [resolve(import.meta.dirname, "../index.ts")],
      extensionFactories: [
        {
          name: "privacy-redactor",
          factory: (pi) => {
            pi.on("context", (event) => {
              redactions += 1;
              return {
                messages: event.messages.map((message) => {
                  if (message.role !== "user") return message;
                  if (typeof message.content === "string") {
                    return { ...message, content: message.content.replaceAll("PRIVATE_PARENT_SECRET", "[REDACTED]") };
                  }
                  return {
                    ...message,
                    content: message.content.map((part) =>
                      part.type === "text"
                        ? { ...part, text: part.text.replaceAll("PRIVATE_PARENT_SECRET", "[REDACTED]") }
                        : part,
                    ),
                  };
                }),
              };
            });
          },
        },
      ],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(cwd);
    const result = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: registry.find(parent.provider, parent.getModel().id),
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager,
      noTools: "builtin",
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    session = result.session;
    await session.bindExtensions({});
    const notices = [];
    session.extensionRunner.setUIContext(
      { notify: (message, level) => notices.push({ message, level }), setStatus() {}, setWidget() {} },
      "rpc",
    );

    await session.prompt("Build a preview containing PRIVATE_PARENT_SECRET and verify it carefully.");
    assert.equal(parentWire.length, 1);
    assert.ok(redactions > 0, "the real Pi context hook must run for the parent request");
    assert.doesNotMatch(JSON.stringify(parentWire[0]), /PRIVATE_PARENT_SECRET/);
    assert.match(JSON.stringify(parentWire[0]), /\[REDACTED\]/);
    assert.match(JSON.stringify(manager.getBranch()), /PRIVATE_PARENT_SECRET/, "session history remains raw");
    assert.equal(recap.state.callCount, 0, "agent settlement must not dispatch by default");
    await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(recap.state.callCount, 0, "resume must stay quiet without explicit consent");

    const flags = session.extensionRunner;
    const target = `${recap.provider}/${recap.getModel().id}`;
    await session.prompt("/recap");
    assert.equal(recapWire.length, 0, "manual invocation without consent must not dispatch");
    assert.match(notices.at(-1).message, /--recap-allow-raw-history.*--recap-model/);

    flags.setFlagValue("recap-model", target);
    await session.prompt("/recap");
    assert.equal(recapWire.length, 0, "a destination alone is not consent");

    flags.setFlagValue("recap-allow-raw-history", true);
    flags.setFlagValue("recap-model", "missing/not-found");
    await session.prompt("/recap");
    assert.equal(recapWire.length, 0, "invalid target must not fall back to active model");
    assert.match(notices.at(-1).message, /unavailable or virtual/);

    flags.setFlagValue("recap-model", target);
    const facade = session.extensionRunner.getModelRegistry();
    const getAuth = facade.getApiKeyAndHeaders.bind(facade);
    assert.equal(facade.find(recap.provider, recap.getModel().id).baseUrl, "https://registered.example");
    let redirectResolutions = 0;
    facade.getApiKeyAndHeaders = async (model) => {
      const auth = await getAuth(model);
      if (model.provider !== recap.provider) return auth;
      redirectResolutions += 1;
      return { ...auth, baseUrl: "https://different-auth-endpoint.example" };
    };
    await session.prompt("/recap");
    assert.equal(redirectResolutions, 1);
    assert.equal(recapWire.length, 0, "a named model cannot authorize a different auth-resolved endpoint");
    assert.match(notices.at(-1).message, /different endpoint.*No history was sent/);

    const manualNoticeCount = notices.length;
    await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(redirectResolutions, 2, "automatic resume attempts must also check the endpoint");
    assert.equal(recapWire.length, 0);
    assert.equal(notices.length, manualNoticeCount, "automatic endpoint mismatch must stay quiet");

    facade.getApiKeyAndHeaders = getAuth;
    await session.prompt("/recap");
    assert.equal(recapWire.length, 1);
    assert.equal(parentWire.length, 1, "recap must go to the named destination, not the parent provider");
    assert.equal(recapWire[0].model.provider, recap.provider);
    assert.match(JSON.stringify(recapWire[0].context.messages), /PRIVATE_PARENT_SECRET/);
    assert.doesNotMatch(JSON.stringify(recapWire[0].context.messages), /\[REDACTED\]/);
    assert.ok(!recapWire[0].context.systemPrompt);
    assert.equal(recapWire[0].options.cacheRetention, "none");
    assert.equal(recapWire[0].options.reasoning, undefined);

    // Real Pi changes the active model while recap auth is pending. The already
    // captured raw history must not dispatch after that switch.
    let releaseAuth;
    let authStarted;
    const started = new Promise((resolve) => {
      authStarted = resolve;
    });
    const authGate = new Promise((resolve) => {
      releaseAuth = resolve;
    });
    facade.getApiKeyAndHeaders = async (model) => {
      if (model.provider === recap.provider) {
        authStarted();
        await authGate;
      }
      return getAuth(model);
    };
    const pending = session.prompt("/recap");
    await started;
    await session.setModel(registry.find(recap.provider, recap.getModel().id));
    releaseAuth();
    await pending;
    assert.equal(recapWire.length, 1, "model switch during auth must not dispatch the pending history");
  } finally {
    session?.dispose();
    unregisterApiProviders(sourceId);
    await rm(cwd, { recursive: true, force: true });
  }
});
