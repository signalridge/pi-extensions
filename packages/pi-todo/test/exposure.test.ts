import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getPackageDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import todo from "../src/extension.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  options: {
    tools?: string[];
    defaultTools?: string[];
    copiedSdkTodo?: boolean;
    before?: (pi: ExtensionAPI) => void;
    after?: (pi: ExtensionAPI) => void;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "todo-exposure-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "todo-exposure", models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("todo-exposure", "fixture");
  if (!model) throw new Error("No fixture model");
  let api!: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      ...(options.before ? [{ name: "before", factory: options.before }] : []),
      {
        name: "todo",
        factory: (pi) => {
          api = pi;
          todo(pi);
        },
      },
      ...(options.after ? [{ name: "after", factory: options.after }] : []),
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const definition = loader
    .getExtensions()
    .extensions.find((e) => e.path.includes("todo"))
    ?.tools.get("todo")?.definition;
  if (!definition) throw new Error("Missing factory-registered Todo");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({
      defaultTools: options.defaultTools,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    sessionManager: SessionManager.inMemory(cwd),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.copiedSdkTodo
      ? { customTools: [{ ...definition, execute: async () => ({ content: [], details: "foreign" }) }] }
      : {}),
  });
  cleanups.push(async () => {
    await session.abort();
    session.dispose();
  });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (e) => errors.push(String(e)) });
  return { session, api, faux, loader, errors };
}

describe("factory registration and effective public exposure", () => {
  it("is registered before startup and is model-usable by default when explicitly loaded", async () => {
    const f = await fixture();
    expect(
      f.loader
        .getExtensions()
        .extensions.find((e) => e.path.includes("todo"))
        ?.tools.has("todo"),
    ).toBe(true);
    expect(f.session.getActiveToolNames()).toContain("todo");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo", { action: "list" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Listed."),
    ]);
    await f.session.prompt("List the checklist.");
    expect(f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "todo")).toMatchObject({
      isError: false,
      details: { revision: 0 },
    });
  });
  it("actual CLI --tools includes Todo without reactivating an earlier restricted startup loadout", () => {
    const cwd = mkdtempSync(join(tmpdir(), "todo-cli-exposure-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const probe = join(cwd, "probe.ts");
    for (const restrict of [false, true]) {
      writeFileSync(
        probe,
        `export default function(pi) {
        ${restrict ? 'pi.on("session_start", () => pi.setActiveTools(["read"]));' : ""}
        pi.registerCommand("todo-exposure-probe", { handler: async () => console.log("TODO_EXPOSURE=" + JSON.stringify(pi.getActiveTools())) });
      }`,
      );
      const result = spawnSync(
        process.execPath,
        [
          join(getPackageDir(), "dist", "cli.js"),
          "--offline",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-themes",
          "--no-prompt-templates",
          "--no-mcp",
          "--no-session",
          "--extension",
          probe,
          "--extension",
          fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          "--tools",
          "read,write,todo",
          "--print",
          "/todo-exposure-probe",
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_TELEMETRY: "0",
            NODE_PATH: [dirname(dirname(getPackageDir())), process.env.NODE_PATH].filter(Boolean).join(":"),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        `TODO_EXPOSURE=${JSON.stringify(restrict ? ["read"] : ["read", "write", "todo"])}`,
      );
    }
  });
  it("resolves defaultTools +todo before session_start", async () => {
    const f = await fixture({ defaultTools: ["+todo"] });
    expect(f.session.getActiveToolNames()).toContain("todo");
    expect(f.errors).toEqual([]);
  });
  it("preserves an earlier startup read-only policy despite an initial read/write/todo allowlist", async () => {
    const f = await fixture({
      tools: ["read", "write", "todo"],
      before: (pi) => {
        pi.on("session_start", () => {
          pi.setActiveTools(["read"]);
        });
      },
    });
    expect(f.session.getActiveToolNames()).toEqual(["read"]);
    await f.session.prompt("/todo");
    expect(f.session.getActiveToolNames()).toEqual(["read"]);
  });
  it("detects a different effective origin even when parameters/instructions are copied", async () => {
    const f = await fixture({ copiedSdkTodo: true });
    expect(f.api.getAllTools().find((tool) => tool.name === "todo")?.sourceInfo.source).toBe("sdk");
    const blocked = await f.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "todo",
      toolCallId: "collision",
      input: { action: "list" },
    });
    expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("another effective todo tool") });
    expect(f.session.sessionManager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
  });
  it("public discovery cannot enumerate excluded definitions; the excluded human command still works", async () => {
    const f = await fixture({
      tools: [],
      after: (pi) => {
        pi.on("session_start", () => {
          pi.registerTool({
            name: "todo",
            label: "excluded",
            description: "excluded foreign tool",
            parameters: { type: "object" },
            execute: async () => ({ content: [], details: undefined }),
          });
        });
      },
    });
    expect(f.api.getAllTools()).toEqual([]);
    await f.session.prompt("/todo");
    expect(f.session.getActiveToolNames()).toEqual([]);
    expect(f.errors).toEqual([]);
  });
  it("does not activate excluded tools or override a later Plan loadout", async () => {
    for (const tools of [[], ["read", "todo"]]) {
      const f = await fixture({
        tools,
        after: (pi) => {
          pi.on("session_start", () => {
            pi.setActiveTools(tools.length ? ["read"] : []);
          });
        },
      });
      expect(f.session.getActiveToolNames()).toEqual(tools.length ? ["read"] : []);
      expect(f.errors).toEqual([]);
    }
  });
});
