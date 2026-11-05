import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { PLACEHOLDER_GUIDELINE, registerSecrets } from "../src/index.js";
import { fake } from "./fixtures.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const ENV_VALUE = "demo-api-value-7Q2x9Z";
const GITHUB_TOKEN = fake("gh", "p_", "Zz9y".repeat(9));
const placeholderOf = (label: string) => new RegExp(`\\$\\$${label}_[A-Z0-9]{12}\\$\\$`);

function firstMatch(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match) throw new Error(`no ${pattern} in ${text}`);
  return match[0];
}

function conversationOf(context: TranscriptContext): string {
  return JSON.stringify(context.messages.filter((message) => message.role !== "system"));
}

async function fixture(options: { before: (pi: ExtensionAPI) => void; after: (pi: ExtensionAPI) => void }) {
  expect(VERSION).toBe("1.5.0");
  const root = mkdtempSync(join(tmpdir(), "pi-secrets-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const faux = fauxProvider({
    provider: "secrets-test",
    models: [{ id: "fixture" }],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("secrets-test", "fixture");
  if (!model) throw new Error("Missing test model");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    extensionFactories: [
      { name: "before", factory: options.before },
      // A fixed environment keeps the test independent of the developer's real variables.
      {
        name: "secrets",
        factory: (pi) => registerSecrets(pi, { env: () => ({ DEMO_API_TOKEN: ENV_VALUE }) }),
      },
      { name: "after", factory: options.after },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: ["bash", "probe"],
  });
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
    faux.setResponses([]);
  });
  const errors: string[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(String(error.error)),
  });
  return { session, faux, errors, agentDir };
}

it("sends placeholders to the provider while tools receive the real values", async () => {
  const beforeInputs: unknown[] = [];
  const afterInputs: unknown[] = [];
  const probed: unknown[] = [];
  const f = await fixture({
    before: (pi) => {
      // Loaded first: its `context` addition is still obfuscated, but its
      // `tool_call` handler runs before restoration and sees placeholders.
      pi.on("context", (event) => ({
        messages: [
          ...event.messages,
          {
            role: "custom",
            customType: "note",
            content: `note ${ENV_VALUE}`,
            display: false,
            timestamp: 1,
          },
        ],
      }));
      pi.on("tool_call", (event) => {
        beforeInputs.push(structuredClone(event.input));
      });
    },
    after: (pi) => {
      pi.on("tool_call", (event) => {
        afterInputs.push(structuredClone(event.input));
      });
      pi.registerTool({
        name: "probe",
        label: "probe",
        description: "records its arguments",
        parameters: {
          type: "object",
          properties: {
            headers: {
              type: "object",
              properties: { authorization: { type: "string" } },
            },
            tokens: { type: "array", items: { type: "string" } },
          },
          required: ["headers", "tokens"],
        },
        async execute(_id, args) {
          probed.push(structuredClone(args));
          return {
            content: [{ type: "text", text: "probe ok" }],
            details: undefined,
          };
        },
      });
    },
  });

  const contexts: TranscriptContext[] = [];
  let envPlaceholder = "";
  let githubPlaceholder = "";
  f.faux.setResponses([
    (context) => {
      contexts.push(structuredClone(context));
      envPlaceholder = firstMatch(conversationOf(context), placeholderOf("DEMO_API_TOKEN"));
      // The GitHub token is printed in two pieces so the model-authored command never contains it.
      const command = `printf '%s\\n%s%s\\n' '${envPlaceholder}' 'gh' '${GITHUB_TOKEN.slice(2)}'`;
      return fauxAssistantMessage(fauxToolCall("bash", { command }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      contexts.push(structuredClone(context));
      githubPlaceholder = firstMatch(conversationOf(context), placeholderOf("GITHUB_TOKEN"));
      return fauxAssistantMessage(
        fauxToolCall("probe", {
          headers: { authorization: `token ${githubPlaceholder}` },
          tokens: [envPlaceholder, "plain"],
        }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("done");
    },
  ]);

  await f.session.prompt(`Deploy with ${ENV_VALUE}`);
  expect(f.errors).toEqual([]);
  expect(contexts).toHaveLength(3);

  // Provider side: no request carries either value; the history is byte-stable across requests.
  for (const context of contexts) {
    const sent = JSON.stringify(context);
    expect(sent).not.toContain(ENV_VALUE);
    expect(sent).not.toContain(GITHUB_TOKEN);
  }
  const firstUser = (context: TranscriptContext) => JSON.stringify(context.messages.find((m) => m.role === "user"));
  expect(firstUser(contexts[0] as TranscriptContext)).toContain(`Deploy with ${envPlaceholder}`);
  expect(new Set(contexts.map((context) => firstUser(context))).size).toBe(1);
  expect(conversationOf(contexts[0] as TranscriptContext)).toContain(`note ${envPlaceholder}`);
  const toolResult = (contexts[1] as TranscriptContext).messages.find((m) => m.role === "toolResult");
  expect(toolResult?.content).toEqual([{ type: "text", text: `${envPlaceholder}\n${githubPlaceholder}\n` }]);
  const system = (contexts[0] as TranscriptContext).messages
    .filter((message) => message.role === "system")
    .map((message) => getSystemMessageText(message))
    .join("\n");
  expect(system).toContain(PLACEHOLDER_GUIDELINE);

  // Tool side: bash printed the real value, so it ran the restored command; nested probe input was restored.
  const bashResult = f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "bash");
  expect(bashResult?.role === "toolResult" && bashResult.content).toEqual([
    { type: "text", text: `${ENV_VALUE}\n${GITHUB_TOKEN}\n` },
  ]);
  expect(probed).toEqual([
    {
      headers: { authorization: `token ${GITHUB_TOKEN}` },
      tokens: [ENV_VALUE, "plain"],
    },
  ]);
  expect(JSON.stringify(beforeInputs)).toContain(envPlaceholder);
  expect(JSON.stringify(beforeInputs)).not.toContain(ENV_VALUE);
  expect(afterInputs).toEqual([
    {
      command: `printf '%s\\n%s%s\\n' '${ENV_VALUE}' 'gh' '${GITHUB_TOKEN.slice(2)}'`,
    },
    {
      headers: { authorization: `token ${GITHUB_TOKEN}` },
      tokens: [ENV_VALUE, "plain"],
    },
  ]);

  // Storage: entries keep what was typed and returned; model-authored arguments keep placeholders.
  const stored = f.session.sessionManager
    .getEntries()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const user = stored.find((message) => message.role === "user");
  expect(JSON.stringify(user)).toContain(`Deploy with ${ENV_VALUE}`);
  const calls = stored.flatMap((message) =>
    message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
  );
  expect(calls.map((call) => call.arguments)).toEqual([
    {
      command: `printf '%s\\n%s%s\\n' '${envPlaceholder}' 'gh' '${GITHUB_TOKEN.slice(2)}'`,
    },
    {
      headers: { authorization: `token ${githubPlaceholder}` },
      tokens: [envPlaceholder, "plain"],
    },
  ]);
  const storedResult = stored.find((message) => message.role === "toolResult" && message.toolName === "bash");
  expect(JSON.stringify(storedResult)).toContain(GITHUB_TOKEN);

  // The placeholder key persisted for later sessions and is private to the user.
  expect(readFileSync(join(f.agentDir, "pi-secrets.key"), "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
