import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import guidance from "../agent-guidance.js";
import { SUBDIRECTORY_ENTRY } from "../subdirectory-context.js";

interface Fixture {
  cwd: string;
  faux: ReturnType<typeof fauxProvider>;
  start: (options?: { trusted?: boolean; sessionManager?: SessionManager }) => Promise<AgentSession>;
}

async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-guidance-subdir-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const sessions: AgentSession[] = [];
  try {
    mkdirSync(join(cwd, "src", "deep"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(cwd, "AGENTS.md"), "root guidance loaded by pi");
    writeFileSync(join(cwd, "src", "AGENTS.md"), "src shared guidance");
    writeFileSync(join(cwd, "src", "CODEX.md"), "src codex guidance");
    writeFileSync(join(cwd, "src", "CLAUDE.md"), "src claude guidance");
    writeFileSync(join(cwd, "src", "deep", "AGENTS.override.md"), "deep override guidance");
    writeFileSync(join(cwd, "src", "deep", "AGENTS.md"), "deep shadowed guidance");
    writeFileSync(join(cwd, "src", "deep", "file.ts"), "export const deep = 1;\n");
    writeFileSync(join(cwd, "src", "other.ts"), "export const other = 2;\n");
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({
      provider: "openai-codex",
      api: "guidance-subdir-faux",
      models: [{ id: "gpt-5.4", contextWindow: 100_000, maxTokens: 128 }],
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const errors: string[] = [];
    await run({
      cwd,
      faux,
      start: async ({ trusted = true, sessionManager = SessionManager.inMemory(cwd) } = {}) => {
        const settingsManager = SettingsManager.inMemory(
          {
            compaction: { enabled: false, keepRecentTokens: 10 },
            retry: { enabled: false },
          },
          { projectTrusted: trusted },
        );
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [guidance],
        });
        await resourceLoader.reload();
        expect(resourceLoader.getExtensions().errors).toEqual([]);
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime: runtime,
          model: faux.getModel(),
          thinkingLevel: "off",
          settingsManager,
          sessionManager,
          resourceLoader,
          tools: ["read", "write"],
        });
        sessions.push(session);
        await session.bindExtensions({
          mode: "json",
          onError: (error) => errors.push(error.message),
        });
        return session;
      },
    });
    expect(errors).toEqual([]);
  } finally {
    for (const session of sessions) {
      await session.abort();
      session.dispose();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Queue one tool call followed by a final answer, capturing the follow-up request. */
function readThenAnswer(faux: Fixture["faux"], tool: string, args: Record<string, unknown>, seen: TranscriptContext[]) {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }),
    (context: TranscriptContext) => {
      seen.push(structuredClone(context));
      return fauxAssistantMessage("done");
    },
  ]);
}

function lastToolResultText(session: AgentSession): string[] {
  const result = [...session.messages].reverse().find((message) => message.role === "toolResult");
  if (result?.role !== "toolResult") throw new Error("missing tool result");
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

function deliveries(session: AgentSession): string[][] {
  return session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === SUBDIRECTORY_ENTRY
        ? [(entry.data as { files: { path: string }[] }).files.map((file) => file.path)]
        : [],
    );
}

test("a read below cwd appends unseen nested context once, outermost first, with the model's provider file", async () => {
  await fixture(async ({ cwd, faux, start }) => {
    const session = await start();
    const seen: TranscriptContext[] = [];
    readThenAnswer(faux, "read", { path: "src/deep/file.ts" }, seen);
    await session.prompt("Read the deep file.");
    const blocks = lastToolResultText(session);
    expect(blocks[0]).toContain("export const deep = 1;");
    expect(blocks.slice(1)).toEqual([
      `Context file ${join(cwd, "src", "AGENTS.md")} applies to files below ${join(cwd, "src")}:\n\nsrc shared guidance`,
      `Context file ${join(cwd, "src", "CODEX.md")} applies to files below ${join(cwd, "src")}:\n\nsrc codex guidance`,
      `Context file ${join(cwd, "src", "deep", "AGENTS.override.md")} applies to files below ${join(cwd, "src", "deep")}:\n\ndeep override guidance`,
    ]);
    // The provider sees the delivery in the tool result it is answering.
    const toolResult = seen[0]?.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(toolResult)).toContain("deep override guidance");
    expect(deliveries(session)).toEqual([
      [join(cwd, "src", "AGENTS.md"), join(cwd, "src", "CODEX.md"), join(cwd, "src", "deep", "AGENTS.override.md")],
    ]);

    readThenAnswer(faux, "read", { path: join(cwd, "src", "other.ts") }, seen);
    await session.prompt("Read the other file.");
    expect(lastToolResultText(session)).toEqual(["export const other = 2;\n"]);
    expect(deliveries(session)).toHaveLength(1);
  });
});

test("tree navigation and compaction redeliver what the model can no longer see; resume does not", async () => {
  await fixture(async ({ cwd, faux, start }) => {
    const sessionDir = join(cwd, "..", "sessions");
    const manager = SessionManager.create(cwd, sessionDir);
    let session = await start({ sessionManager: manager });
    const seen: TranscriptContext[] = [];
    readThenAnswer(faux, "read", { path: "src/other.ts" }, seen);
    await session.prompt("First read.");
    expect(lastToolResultText(session)).toHaveLength(3);
    const file = session.sessionManager.getSessionFile();
    if (!file) throw new Error("missing session file");

    // Resume: the persisted branch still carries the delivery.
    session = await start({
      sessionManager: SessionManager.open(file, sessionDir),
    });
    readThenAnswer(faux, "read", { path: "src/other.ts" }, seen);
    await session.prompt("Read again after resume.");
    expect(lastToolResultText(session)).toEqual(["export const other = 2;\n"]);

    // Navigating before the first read leaves its delivery on another branch.
    const first = session.getUserMessagesForForking()[0]?.entryId;
    if (!first) throw new Error("missing tree target");
    await session.navigateTree(first);
    readThenAnswer(faux, "read", { path: "src/other.ts" }, seen);
    await session.prompt("Read on a fresh branch.");
    expect(lastToolResultText(session).slice(1)).toEqual([
      expect.stringContaining("src shared guidance"),
      expect.stringContaining("src codex guidance"),
    ]);

    // Compaction summarizes the delivering tool result away.
    faux.setResponses([fauxAssistantMessage("Summary of the earlier reads.")]);
    await session.prompt("Filler turn so the read falls before the kept range.");
    faux.setResponses([fauxAssistantMessage("Summary of the earlier reads.")]);
    await session.compact();
    readThenAnswer(faux, "read", { path: "src/other.ts" }, seen);
    await session.prompt("Read after compaction.");
    expect(lastToolResultText(session).slice(1)).toEqual([
      expect.stringContaining("src shared guidance"),
      expect.stringContaining("src codex guidance"),
    ]);
  });
});

test("an untrusted project receives no nested context and records nothing", async () => {
  await fixture(async ({ faux, start }) => {
    const session = await start({ trusted: false });
    readThenAnswer(faux, "read", { path: "src/deep/file.ts" }, []);
    await session.prompt("Read the deep file.");
    expect(lastToolResultText(session)).toEqual(["export const deep = 1;\n"]);
    expect(deliveries(session)).toEqual([]);
  });
});

test("a write into a new directory delivers the context of its existing ancestors", async () => {
  await fixture(async ({ cwd, faux, start }) => {
    const session = await start();
    readThenAnswer(faux, "write", { path: "src/fresh/new.ts", content: "export {};\n" }, []);
    await session.prompt("Write a new file.");
    expect(deliveries(session)).toEqual([[join(cwd, "src", "AGENTS.md"), join(cwd, "src", "CODEX.md")]]);
  });
});
