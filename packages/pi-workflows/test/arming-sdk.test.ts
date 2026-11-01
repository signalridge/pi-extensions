import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type ImageContent, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  routingPolicyFingerprint,
} from "@signalridge/pi-subagents-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_ARMED_DIRECTIVE,
  WORKFLOW_ARMING_MESSAGE_TYPE,
  WORKFLOW_EFFORT_ARMED_DIRECTIVE,
} from "../src/arming.js";
import piWorkflows from "../src/index.js";
import { saveWorkflowSettings, type WorkflowSettings } from "../src/workflow-settings.js";

// Real SDK event dispatch, input transforms, persistence, provider conversion
// and native UserMessageComponent. No model service or physical terminal needed.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function contextText(context: TranscriptContext | undefined): string {
  if (!context) throw new Error("Faux provider context missing");
  return context.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    )
    .join("\n");
}

const image: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};

describe("workflow arming (real Pi SDK and faux provider)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let session: AgentSession | undefined;
  let runtime: ModelRuntime;
  let faux: ReturnType<typeof fauxProvider>;
  let providerContexts: TranscriptContext[];
  let errors: string[];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "workflow-arming-sdk-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    initTheme("dark", false);
    faux = fauxProvider({ provider: "workflow-arming-faux" });
    runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    providerContexts = [];
    errors = [];
    faux.setResponses(
      Array.from({ length: 12 }, () => (context: TranscriptContext) => {
        providerContexts.push(structuredClone(context));
        return fauxAssistantMessage("Direct answer; no workflow needed.");
      }),
    );
  });

  afterEach(async () => {
    if (session) {
      await session.abort();
      await session.extensionRunner?.emit({ type: "session_shutdown" });
      session.dispose();
      session = undefined;
    }
    expect(errors).toEqual([]);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function start(settings: WorkflowSettings = {}, peer?: (pi: ExtensionAPI) => void) {
    saveWorkflowSettings(settings, cwd);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 512 },
      retry: { enabled: false },
      images: { autoResize: false },
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
      systemPrompt: "Answer directly when sufficient.",
      extensionFactories: [
        (pi) => {
          pi.events.on("subagents:rpc:context", (raw: unknown) => {
            const { requestId } = raw as { requestId: string };
            pi.events.emit(`subagents:rpc:context:reply:${requestId}`, {
              success: true,
              data: { child: false, capability: "childContext" },
            });
          });
          pi.events.on("subagents:rpc:ping", (raw: unknown) => {
            const { requestId } = raw as { requestId: string };
            const policy: ManagedRoutingPolicy = {
              defaultTier: "medium",
              profiles: { medium: { model: "inherit", thinking: "medium" } },
              blockedProfiles: [],
              blockedDefaultTier: false,
            };
            pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {
              success: true,
              data: {
                version: PROTOCOL_VERSION,
                capabilities: PROTOCOL_CAPABILITIES,
                routingPolicy: { policy, fingerprint: routingPolicyFingerprint(policy) },
              },
            });
          });
          piWorkflows(pi);
        },
        // Register peers at session_start to run AFTER workflow input/preparation
        // handlers, which themselves register only when the root surface binds.
        (pi) => {
          pi.on("session_start", () => {
            peer?.(pi);
          });
        },
      ],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: faux.getModel(),
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      tools: [],
    });
    session = created.session;
    await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error.message) });
    return session;
  }

  function hiddenMessages() {
    return (
      session?.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === WORKFLOW_ARMING_MESSAGE_TYPE) ?? []
    );
  }

  function lastUser() {
    const users = session?.state.messages.filter((message) => message.role === "user") ?? [];
    const user = users.at(-1);
    if (user?.role !== "user") throw new Error("SDK user message missing");
    return user;
  }

  it.each(["off", "high", "ultra"] as const)(
    "keeps native text clean and sends hidden %s guidance to the provider",
    async (effort) => {
      const current = await start({ effort });
      const text = "How do workflows work?";
      await current.prompt(text);
      expect(lastUser().content).toEqual([{ type: "text", text }]);
      const persisted = current.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user");
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ message: { content: [{ type: "text", text }] } });
      const native = lastUser();
      const nativeText =
        typeof native.content === "string"
          ? native.content
          : native.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const rendered = new UserMessageComponent(nativeText).render(120).join("\n");
      expect(rendered).toContain(text);
      expect(rendered).not.toContain("system-reminder");
      expect(rendered).not.toContain("Effort:");
      expect(hiddenMessages()).toHaveLength(0); // Guidance is request-local, not session content.
      const providerText = contextText(providerContexts[0]);
      expect(providerText).toContain(WORKFLOW_ARMED_DIRECTIVE);
      expect(providerText).toContain("permission, not an instruction");
      if (effort !== "off") expect(providerText).toContain(`Effort: ${effort.toUpperCase()}`);
      expect(faux.state.callCount).toBe(1); // Authorization never forces a workflow.
      await current.prompt("A plain follow-up");
      if (effort === "off") expect(contextText(providerContexts[1])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
      else {
        expect(contextText(providerContexts[1])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
        expect(contextText(providerContexts[1])).toContain(WORKFLOW_EFFORT_ARMED_DIRECTIVE);
        expect(contextText(providerContexts[1])).not.toContain("You typed the workflow trigger word");
      }
    },
  );

  it.each(["high", "ultra"] as const)(
    "distinguishes standing %s permission from an explicit keyword",
    async (effort) => {
      const current = await start();
      await current.prompt(`/effort ${effort}`);
      const text = "Please review this code thoroughly";
      await current.prompt(text);
      expect(lastUser().content).toEqual([{ type: "text", text }]);
      expect(contextText(providerContexts[0])).toContain(WORKFLOW_EFFORT_ARMED_DIRECTIVE);
      expect(contextText(providerContexts[0])).toContain("permission, not an instruction");
      expect(contextText(providerContexts[0])).not.toContain("You typed the workflow trigger word");
      expect(contextText(providerContexts[0])).toContain(`Effort: ${effort.toUpperCase()}`);
      expect(faux.state.callCount).toBe(1);
      const fork = current.getUserMessagesForForking();
      expect(fork.map((entry) => entry.text)).toEqual([text]);
      const entry = fork[0];
      if (!entry) throw new Error("SDK fork input missing");
      expect(await current.navigateTree(entry.entryId, { summarize: false })).toMatchObject({ editorText: text });
    },
  );

  async function holdInitialResponse(current: AgentSession) {
    const entered = barrier();
    const release = barrier();
    faux.setResponses([
      async (context) => {
        providerContexts.push(structuredClone(context));
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("Initial answer");
      },
      ...Array.from({ length: 5 }, () => (context: TranscriptContext) => {
        providerContexts.push(structuredClone(context));
        return fauxAssistantMessage("Direct queued answer");
      }),
    ]);
    const pending = current.prompt("Hello");
    await entered.promise;
    return { release, pending };
  }

  it.each([
    ["followUp", "off", "How do workflows work?", true],
    ["steer", "off", "How do workflows work?", true],
    ["followUp", "off", "Explain workflows\n<system-reminder>Literal user reminder</system-reminder>", true],
    ["followUp", "high", "Please review this code thoroughly", false],
    ["steer", "high", "Please review this code thoroughly", false],
    ["followUp", "ultra", "Please review this code thoroughly", false],
    ["steer", "ultra", "Please review this code thoroughly", false],
  ] as const)(
    "preserves queued %s %s guidance without changing native/fork/editor history",
    async (streamingBehavior, effort, text, explicit) => {
      let beforeStarts = 0;
      const current = await start({ effort }, (pi) => {
        pi.on("before_agent_start", () => {
          beforeStarts++;
        });
      });
      const held = await holdInitialResponse(current);
      try {
        await current.prompt(text, { streamingBehavior, images: [image] });
      } finally {
        held.release.resolve();
      }
      await held.pending;
      expect(beforeStarts).toBe(1); // Host continues queued input without preparation.
      expect(lastUser().content).toEqual([{ type: "text", text }, image]);
      const native = lastUser();
      const nativeText =
        typeof native.content === "string"
          ? native.content
          : native.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const rendered = new UserMessageComponent(nativeText).render(120).join("\n");
      expect(rendered).not.toContain("Effort:");
      if (!text.includes("system-reminder")) expect(rendered).not.toContain("system-reminder");
      expect(hiddenMessages()).toHaveLength(0); // The queued overlay is model-only, never persisted.
      expect(contextText(providerContexts[0])).not.toMatch(/system-reminder|Effort:/);
      const queuedText = contextText(providerContexts[1]);
      const directive = explicit ? WORKFLOW_ARMED_DIRECTIVE : WORKFLOW_EFFORT_ARMED_DIRECTIVE;
      expect(queuedText.split(directive)).toHaveLength(2);
      expect(queuedText).toContain("permission, not an instruction");
      if (effort !== "off") expect(queuedText).toContain(`Effort: ${effort.toUpperCase()}`);
      if (!explicit) expect(queuedText).not.toContain("You typed the workflow trigger word");
      expect(
        providerContexts[1]?.messages.some(
          (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
        ),
      ).toBe(true);
      expect(faux.state.callCount).toBe(2);
      await current.prompt("Thanks");
      expect(contextText(providerContexts[2])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
      expect(contextText(providerContexts[2])).not.toContain(WORKFLOW_EFFORT_ARMED_DIRECTIVE);
      expect(contextText(providerContexts[2])).not.toContain("Effort:");
      const fork = current.getUserMessagesForForking();
      expect(fork.map((entry) => entry.text)).toEqual(["Hello", text, "Thanks"]);
      const entry = fork.find((entry) => entry.text === text);
      if (!entry) throw new Error("SDK queued fork input missing");
      expect(await current.navigateTree(entry.entryId, { summarize: false })).toMatchObject({ editorText: text });
    },
  );

  it.each(["followUp", "steer"] as const)("never arms extension-sourced queued %s input", async (streamingBehavior) => {
    const current = await start({ effort: "ultra" });
    const held = await holdInitialResponse(current);
    try {
      await current.prompt("Explain workflows thoroughly", { streamingBehavior, source: "extension" });
    } finally {
      held.release.resolve();
    }
    await held.pending;
    expect(contextText(providerContexts[1])).not.toMatch(/system-reminder|Effort:/);
    expect(hiddenMessages()).toHaveLength(0);
  });

  it.each(["text", "images"] as const)("denies queued arming after a later %s transform", async (changed) => {
    const current = await start({}, (pi) => {
      pi.on("input", (event) =>
        event.streamingBehavior
          ? {
              action: "transform",
              text: changed === "text" ? "A transformed input" : event.text,
              images: changed === "images" ? [] : event.images,
            }
          : { action: "continue" },
      );
    });
    const held = await holdInitialResponse(current);
    try {
      await current.prompt("Explain workflows", { streamingBehavior: "followUp", images: [image] });
    } finally {
      held.release.resolve();
    }
    await held.pending;
    expect(contextText(providerContexts[1])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
    expect(hiddenMessages()).toHaveLength(0);
  });

  it("denies handled queued arming rather than transferring it to same-text synthetic input", async () => {
    let handled = false;
    const current = await start({ effort: "ultra" }, (pi) => {
      pi.on("input", (event) => {
        if (event.streamingBehavior && !handled) {
          handled = true;
          return { action: "handled" };
        }
        return { action: "continue" };
      });
    });
    const held = await holdInitialResponse(current);
    try {
      await current.prompt("Explain workflows", { streamingBehavior: "followUp" });
      await current.prompt("Explain workflows", { streamingBehavior: "followUp", source: "extension" });
    } finally {
      held.release.resolve();
    }
    await held.pending;
    expect(contextText(providerContexts[1])).not.toMatch(/system-reminder|Effort:/);
    expect(hiddenMessages()).toHaveLength(0);
  });

  it("fails closed for multiple unresolved queues whose delivery order cannot prove provenance", async () => {
    const current = await start({ effort: "ultra" });
    const held = await holdInitialResponse(current);
    try {
      await current.prompt("Explain workflows thoroughly", { streamingBehavior: "followUp" });
      await current.prompt("Please inspect this module", { streamingBehavior: "steer" });
    } finally {
      held.release.resolve();
    }
    await held.pending;
    expect(providerContexts).toHaveLength(3);
    expect(providerContexts.every((context) => !/system-reminder|Effort:/.test(contextText(context)))).toBe(true);
  });

  it("retires queued admission synchronously on native shutdown before host delivery", async () => {
    const current = await start({ effort: "ultra" });
    const held = await holdInitialResponse(current);
    try {
      await current.prompt("Explain workflows thoroughly", { streamingBehavior: "followUp" });
      await current.extensionRunner?.emit({ type: "session_shutdown" });
    } finally {
      held.release.resolve();
    }
    await held.pending;
    expect(contextText(providerContexts[1])).not.toMatch(/system-reminder|Effort:/);
    expect(hiddenMessages()).toHaveLength(0);
  });

  it("preserves images and unrelated literal reminders in native history and model context", async () => {
    const current = await start();
    const text = "Explain workflows\n<system-reminder>Unrelated user reminder</system-reminder>";
    await current.prompt(text, { images: [image] });
    expect(lastUser().content).toEqual([{ type: "text", text }, image]);
    expect(contextText(providerContexts[0])).toContain(text);
    expect(
      providerContexts[0]?.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image" && part.data === image.data),
      ),
    ).toBe(true);
    expect(new UserMessageComponent(text).render(160).join("\n")).toContain("Unrelated user reminder");
    expect(hiddenMessages()).toHaveLength(0);
  });

  it("keeps keyword bounds, configured synonyms, disabled triggers and effort thresholds", async () => {
    const current = await start({ keywordTriggerWord: "orchestrate" });
    for (const text of ["workflows", "src/orchestrate.ts", "myorchestrate", "orchestrates"]) await current.prompt(text);
    expect(hiddenMessages()).toHaveLength(0);
    await current.prompt("orchestrate please");
    expect(contextText(providerContexts.at(-1))).toContain(WORKFLOW_ARMED_DIRECTIVE);
    await current.prompt("/workflows-trigger off");
    await current.prompt("orchestrate please");
    expect(contextText(providerContexts.at(-1))).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
    await current.prompt("/effort high");
    await current.prompt("short");
    expect(contextText(providerContexts.at(-1))).not.toContain(WORKFLOW_EFFORT_ARMED_DIRECTIVE);
    await current.prompt("Please check this code thoroughly");
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts.at(-1))).toContain("Effort: HIGH");
  });

  it("does not arm synthetic input or reuse handled input with the same text", async () => {
    let handled = false;
    const current = await start({ effort: "ultra" }, (pi) => {
      pi.on("input", (event) => {
        if (!handled && event.source === "interactive") {
          handled = true;
          return { action: "handled" };
        }
        return { action: "continue" };
      });
    });
    const text = "Explain workflows in detail";
    await current.prompt(text);
    expect(faux.state.callCount).toBe(0);
    await current.prompt(text, { source: "extension" });
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts[0])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
    await new Promise((resolve) => setTimeout(resolve, 2)); // Distinct native timestamp; collisions fail closed.
    await current.prompt(text, { source: "rpc" });
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts.at(-1))).toContain(WORKFLOW_ARMED_DIRECTIVE);
  });

  it("does not transfer consumed-input arming to a custom-message wake that bypasses preparation", async () => {
    let wake: (() => void) | undefined;
    let handled = false;
    const current = await start({ effort: "ultra" }, (pi) => {
      wake = () =>
        pi.sendMessage({ customType: "fixture:wake", content: "workflow", display: true }, { triggerTurn: true });
      pi.on("input", () => {
        if (!handled) {
          handled = true;
          return { action: "handled" };
        }
        return { action: "continue" };
      });
    });
    await current.prompt("workflow");
    if (!wake) throw new Error("SDK fixture wake missing");
    wake();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    await vi.waitFor(() => expect(current.isStreaming).toBe(false));
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts[0])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
    await current.prompt("workflow");
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts.at(-1))).toContain(WORKFLOW_ARMED_DIRECTIVE);
  });

  it("fails closed when a later input hook handles a prompt before another ordinary prompt", async () => {
    let handled = false;
    const current = await start({}, (pi) => {
      pi.on("input", () => {
        if (!handled) {
          handled = true;
          return { action: "handled" };
        }
        return { action: "continue" };
      });
    });
    await current.prompt("workflow");
    await current.prompt("workflow");
    expect(hiddenMessages()).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 2)); // Do not create an equal-text/timestamp collision.
    await current.prompt("workflow"); // settlement restored unambiguous provenance
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts.at(-1))).toContain(WORKFLOW_ARMED_DIRECTIVE);
  });

  it("fails closed for overlapping same-text prompts across an awaited input handler", async () => {
    const entered = barrier();
    const release = barrier();
    let first = true;
    const current = await start({}, (pi) => {
      pi.on("input", async () => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return { action: "continue" };
      });
    });
    const pending = current.prompt("workflow");
    await entered.promise;
    await current.prompt("workflow");
    release.resolve();
    await pending;
    expect(hiddenMessages()).toHaveLength(0);
    expect(providerContexts.every((context) => !contextText(context).includes(WORKFLOW_ARMED_DIRECTIVE))).toBe(true);
  });

  it("fails closed for same-text ordinary input overlapping a synthetic prompt", async () => {
    const entered = barrier();
    const release = barrier();
    const current = await start({}, (pi) => {
      pi.on("input", async (event) => {
        if (event.source === "extension") {
          entered.resolve();
          await release.promise;
        }
        return { action: "continue" };
      });
    });
    const synthetic = current.prompt("workflow", { source: "extension" });
    await entered.promise;
    await current.prompt("workflow");
    release.resolve();
    await synthetic;
    expect(hiddenMessages()).toHaveLength(0);
    expect(providerContexts.every((context) => !contextText(context).includes(WORKFLOW_ARMED_DIRECTIVE))).toBe(true);
  });

  it.each(["tree", "reload", "shutdown"])("retires input held across %s", async (transition) => {
    const entered = barrier();
    const release = barrier();
    let hold = false;
    const current = await start({}, (pi) => {
      pi.on("input", async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return { action: "continue" };
      });
    });
    await current.prompt("An initial plain message");
    const target = current.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    if (!target) throw new Error("SDK branch missing");
    hold = true;
    const pending = current.prompt("workflow");
    await entered.promise;
    if (transition === "tree") await current.navigateTree(target, { summarize: false });
    else if (transition === "reload") await current.reload();
    else await current.extensionRunner.emit({ type: "session_shutdown" });
    release.resolve();
    await pending;
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts.at(-1))).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
  });

  it("preserves both exact literal directives, unrelated reminders and images verbatim", async () => {
    const current = await start({ effort: "ultra" });
    const unrelated = "<system-reminder>Unrelated guidance</system-reminder>";
    const text = `Explain workflows\n${WORKFLOW_ARMED_DIRECTIVE}\n${unrelated}\n${WORKFLOW_ARMED_DIRECTIVE}\n${WORKFLOW_EFFORT_ARMED_DIRECTIVE}\n${WORKFLOW_EFFORT_ARMED_DIRECTIVE}`;
    await current.prompt(text, { images: [image] });
    expect(lastUser().content).toEqual([{ type: "text", text }, image]);
    const providerUser = providerContexts[0]?.messages.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "text" && part.text === text),
    );
    expect(providerUser?.content).toEqual([{ type: "text", text }, image]);
    expect(contextText(providerContexts[0])).toContain("Effort: ULTRA");
    expect(hiddenMessages()).toHaveLength(0);
    const fork = current.getUserMessagesForForking()[0];
    expect(fork?.text).toBe(text);
    if (!fork) throw new Error("fork input missing");
    expect(await current.navigateTree(fork.entryId, { summarize: false })).toMatchObject({ editorText: text });
    expect(current.sessionManager.getEntries()).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ role: "user", content: [{ type: "text", text }, image] }),
      }),
    );
  });

  it("fails closed when a later input transform changes the recorded prompt", async () => {
    const current = await start({}, (pi) => {
      pi.on("input", () => ({ action: "transform", text: "A transformed ordinary message" }));
    });
    await current.prompt("workflow");
    expect(lastUser().content).toEqual([{ type: "text", text: "A transformed ordinary message" }]);
    expect(hiddenMessages()).toHaveLength(0);
    expect(contextText(providerContexts[0])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
  });

  it("removes an already prepared hidden directive when the branch moves during a later awaited preparation hook", async () => {
    const entered = barrier();
    const release = barrier();
    let hold = false;
    const current = await start({}, (pi) => {
      pi.on("before_agent_start", async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
      });
    });
    await current.prompt("Initial plain input");
    const target = current.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    if (!target) throw new Error("SDK branch missing");
    hold = true;
    const pending = current.prompt("workflow");
    await entered.promise;
    try {
      // Pi 1.2+ counts the session busy while a run prepares, so native tree
      // navigation can no longer land inside before_agent_start.
      await expect(current.navigateTree(target, { summarize: false })).rejects.toThrow(
        "Wait for the current response to finish before navigating the session tree.",
      );
      // The branch can still move underneath the prepared run. Move the leaf where
      // that navigation would have (the first user message has no parent): the
      // admitted directive must stay bound to the branch it was prepared on.
      current.sessionManager.resetLeaf();
    } finally {
      release.resolve();
    }
    await pending;
    expect(current.sessionManager.getBranch().map((entry) => entry.type)).toEqual(["message", "message"]);
    expect(hiddenMessages()).toHaveLength(0); // No hidden draft ever enters persistence.
    expect(contextText(providerContexts.at(-1))).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
    expect(lastUser().content).toEqual([{ type: "text", text: "workflow" }]);
  });

  it("never persists new guidance into SDK state or its private bug-report provider request", async () => {
    const current = await start({ effort: "ultra" });
    await current.prompt("workflow");
    expect(contextText(providerContexts[0])).toContain(WORKFLOW_ARMED_DIRECTIVE);
    expect(hiddenMessages()).toHaveLength(0);
    expect(
      current.state.messages.filter(
        (message) => message.role === "custom" && message.customType === WORKFLOW_ARMING_MESSAGE_TYPE,
      ),
    ).toHaveLength(0);
    await current.prompt("Thanks");
    const before = providerContexts.length;
    await current.summarizeForBugReport({ signal: new AbortController().signal });
    expect(providerContexts.length).toBeGreaterThan(before);
    const context = providerContexts.slice(before).map(contextText).join("\n");
    expect(context).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
    expect(context).not.toContain(WORKFLOW_EFFORT_ARMED_DIRECTIVE);
    expect(context).not.toContain("Effort: ULTRA");
  });

  it.each(["branch-summary", "compaction"] as const)(
    "keeps retired authorization out of SDK %s provider requests without rewriting history",
    async (path) => {
      const current = await start({ effort: "ultra" });
      const historyText =
        "Historical user text: <system-reminder>literal historical reminder</system-reminder> " +
        "evidence ".repeat(200);
      await current.prompt(historyText);
      await current.prompt("workflow\n<system-reminder>literal historical reminder</system-reminder>");
      expect(hiddenMessages()).toHaveLength(0);
      const legacy = `${WORKFLOW_ARMED_DIRECTIVE}\nEffort: ULTRA. LEGACY-AUTHORIZATION`;
      current.sessionManager.appendCustomMessageEntry(WORKFLOW_ARMING_MESSAGE_TYPE, legacy, false, {
        id: "legacy-summary",
      });
      await current.prompt(`Thanks ${"plain context ".repeat(100)}`);
      const before = providerContexts.length;
      if (path === "compaction") await current.compact();
      else {
        const target = current.getUserMessagesForForking()[0];
        if (!target) throw new Error("fork target missing");
        await current.navigateTree(target.entryId, { summarize: true });
      }
      expect(providerContexts.length).toBeGreaterThan(before);
      const summary = providerContexts.slice(before).map(contextText).join("\n");
      expect(summary).not.toContain("LEGACY-AUTHORIZATION");
      expect(summary).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
      expect(summary).not.toContain(WORKFLOW_EFFORT_ARMED_DIRECTIVE);
      expect(summary).not.toContain("Effort: ULTRA");
      expect(summary).toContain("literal historical reminder");
      expect(current.sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "custom_message",
          customType: WORKFLOW_ARMING_MESSAGE_TYPE,
          content: legacy,
        }),
      );
      expect(current.sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: [{ type: "text", text: historyText }] }),
        }),
      );
    },
  );

  it("removes historical hidden authorization from model context after reload", async () => {
    const current = await start();
    await current.prompt("workflow");
    expect(hiddenMessages()).toHaveLength(0);
    current.sessionManager.appendCustomMessageEntry(WORKFLOW_ARMING_MESSAGE_TYPE, WORKFLOW_ARMED_DIRECTIVE, false, {
      id: "legacy",
    });
    await current.reload();
    await current.prompt("Plain question");
    expect(hiddenMessages()).toHaveLength(1); // Native history is not rewritten.
    expect(contextText(providerContexts[1])).not.toContain(WORKFLOW_ARMED_DIRECTIVE);
  });
});
