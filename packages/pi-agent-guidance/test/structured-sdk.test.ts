import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  getSystemMessageText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import guidance from "../agent-guidance.js";

function systemText(context: TranscriptContext): string {
  return context.messages
    .filter((message) => message.role === "system")
    .map((message) => getSystemMessageText(message))
    .join("\n");
}

async function fixture(
  run: (options: {
    cwd: string;
    agentDir: string;
    runtime: ModelRuntime;
    faux: ReturnType<typeof fauxProvider>;
    start: (factories: ExtensionFactory[], compact?: boolean, customPrompt?: string) => Promise<AgentSession>;
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "pi-guidance-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  let session: AgentSession | undefined;
  try {
    mkdirSync(cwd);
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "CODEX.md"), "global provider guidance");
    writeFileSync(join(cwd, "CODEX.md"), "project provider guidance");
    // Same-content and resolved-path duplicates among supplemental candidates.
    writeFileSync(join(cwd, "DUPLICATE.md"), "project provider guidance");
    writeFileSync(
      join(agentDir, "agent-guidance.json"),
      JSON.stringify({ providers: { "openai-codex": ["CODEX.md", "CODEX.md", "DUPLICATE.md"] } }),
    );
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({
      provider: "openai-codex",
      api: "guidance-sdk-faux",
      models: [{ id: "gpt-5.4", contextWindow: 1024, maxTokens: 128 }],
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const errors: string[] = [];
    await run({
      cwd,
      agentDir,
      runtime,
      faux,
      start: async (factories, compact = false, customPrompt) => {
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: compact, reserveTokens: 100, keepRecentTokens: 10 },
          retry: { enabled: false },
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
          systemPrompt: customPrompt,
          appendSystemPrompt: ["legitimate custom instructions"],
          agentsFilesOverride: () => ({
            agentsFiles: [{ path: join(cwd, "virtual.md"), content: "legitimate custom context" }],
          }),
          extensionFactories: factories,
        });
        await resourceLoader.reload();
        expect(resourceLoader.getExtensions().errors).toEqual([]);
        session = (
          await createAgentSession({
            cwd,
            agentDir,
            modelRuntime: runtime,
            model: faux.getModel(),
            thinkingLevel: "off",
            settingsManager,
            sessionManager: SessionManager.inMemory(cwd),
            resourceLoader,
            tools: ["read", "bash"],
          })
        ).session;
        await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.message) });
        return session;
      },
    });
    expect(errors).toEqual([]);
  } finally {
    if (session) {
      await session.abort();
      session.dispose();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const guidanceFirst of [true, false]) {
  test(`public SDK composes structured policy in ${guidanceFirst ? "guidance-first" : "policy-first"} order and later tool/section edits`, async () => {
    await fixture(async ({ faux, start }) => {
      const contexts: TranscriptContext[] = [];
      faux.setResponses(
        Array.from({ length: 2 }, () => (context: TranscriptContext) => {
          contexts.push(structuredClone(context));
          return fauxAssistantMessage("done");
        }),
      );
      const policy: ExtensionFactory = (pi) => {
        pi.on("before_agent_start", (event) => {
          event.systemPromptOptions.sections.compaction_policy = "compaction policy survives";
        });
      };
      const later: ExtensionFactory = (pi) => {
        pi.on("before_agent_start", (event) => {
          expect(event.systemPromptOptions.forceSystemPrompt).toBeUndefined();
          expect(event.systemPrompt).toContain("project provider guidance");
          event.systemPromptOptions.sections.later_policy = "later section mutation";
          event.systemPromptOptions.selectedTools = ["read"];
          event.systemPromptOptions.toolSnippets.read = "later read tool mutation";
          event.systemPromptOptions.contextFiles.push({ path: "/virtual/later.md", content: "later context mutation" });
        });
      };
      const session = await start([...(guidanceFirst ? [guidance, policy] : [policy, guidance]), later]);
      for (const text of ["unchanged user text", "plain follow-up"]) await session.prompt(text);
      expect(contexts).toHaveLength(2);
      for (const context of contexts) {
        const prompt = systemText(context);
        for (const content of [
          "legitimate custom instructions",
          "legitimate custom context",
          "compaction policy survives",
          "later section mutation",
          "later read tool mutation",
          "later context mutation",
        ])
          expect(prompt).toContain(content);
        expect(prompt).not.toContain("- bash:");
        expect(prompt.split("global provider guidance")).toHaveLength(2);
        expect(prompt.split("project provider guidance")).toHaveLength(2);
        expect(prompt.indexOf("global provider guidance")).toBeLessThan(prompt.indexOf("project provider guidance"));
        const system = context.messages.find((message) => message.role === "system");
        expect(system).toHaveProperty("sections");
      }
      const users = session.messages.filter((message) => message.role === "user");
      expect(users.map((message) => message.content)).toEqual([
        [{ type: "text", text: "unchanged user text" }],
        [{ type: "text", text: "plain follow-up" }],
      ]);
    });
  });
}

test("structured custom preamble/context and an intentional earlier forceSystemPrompt remain compatible", async () => {
  await fixture(async ({ faux, start }) => {
    let rendered = "";
    faux.setResponses([
      (context) => {
        rendered = systemText(context);
        return fauxAssistantMessage("done");
      },
    ]);
    const session = await start([guidance], false, "legitimate custom preamble");
    await session.prompt("hello");
    expect(rendered).toContain("legitimate custom preamble");
    expect(rendered).toContain("legitimate custom context");
    expect(rendered).toContain("project provider guidance");
    const result = await session.extensionRunner?.emitBeforeAgentStart(
      { messageType: "user", prompt: "hello" },
      {
        cwd: session.cwd,
        forceSystemPrompt: "intentional full replacement",
        contextFiles: [],
        sections: { provider_context: "existing provider section\n\n" },
      },
    );
    expect(result?.systemPromptOptions.forceSystemPrompt).toContain("intentional full replacement");
    expect(result?.systemPromptOptions.forceSystemPrompt).toContain("project provider guidance");
    expect(result?.systemPromptOptions.sections.provider_context).toStartWith("existing provider section");
    if (!result) throw new Error("missing SDK runner");
    const again = await session.extensionRunner?.emitBeforeAgentStart(
      { messageType: "user", prompt: "hello" },
      result.systemPromptOptions,
    );
    expect(again?.systemPromptOptions.forceSystemPrompt).toEqual(result.systemPromptOptions.forceSystemPrompt);
    expect(again?.systemPromptOptions.sections.provider_context.split("project provider guidance")).toHaveLength(2);
  });
});

test("an idle custom-message run gets the same provider guidance as a user prompt", async () => {
  await fixture(async ({ faux, start }) => {
    const rendered: string[] = [];
    faux.setResponses(
      Array.from({ length: 2 }, () => (context: TranscriptContext) => {
        rendered.push(systemText(context));
        return fauxAssistantMessage("done");
      }),
    );
    const triggers: string[] = [];
    const probe: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => {
        triggers.push(event.messageType);
      });
    };
    const session = await start([guidance, probe]);
    await session.sendCustomMessage(
      { customType: "guidance-probe", content: "background work finished", display: false },
      { triggerTurn: true },
    );
    await session.waitForIdle();
    await session.prompt("plain follow-up");
    expect(triggers).toEqual(["custom", "user"]);
    expect(rendered).toHaveLength(2);
    for (const prompt of rendered) {
      expect(prompt.split("global provider guidance")).toHaveLength(2);
      expect(prompt.split("project provider guidance")).toHaveLength(2);
    }
  });
});

test("Codex-model automatic compaction retains structured provider/policy context for the next request", async () => {
  await fixture(async ({ faux, start }) => {
    const contexts: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        const answer = fauxAssistantMessage("long answer ".repeat(100));
        answer.usage.input = 950;
        answer.usage.totalTokens = 960;
        return answer;
      },
      fauxAssistantMessage("Summary of the conversation."),
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("follow-up done");
      },
    ]);
    const policy: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections.compaction_policy = "persistent compaction policy";
      });
    };
    const session = await start([guidance, policy], true);
    await session.prompt("Summarize this task ".repeat(100));
    await session.waitForIdle();
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    await session.prompt("Continue without changing user text");
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      const prompt = systemText(context);
      expect(prompt).toContain("persistent compaction policy");
      expect(prompt.split("project provider guidance")).toHaveLength(2);
      expect(context.messages.find((message) => message.role === "system")).toHaveProperty("sections");
    }
  });
});
