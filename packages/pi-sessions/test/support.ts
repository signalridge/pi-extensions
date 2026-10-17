import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import sessions from "../src/index.js";

export const model = {
  provider: "fixture",
  id: "selected",
  name: "Selected",
  api: "openai-completions",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;
export function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function stream(text: string) {
  const result = createAssistantMessageEventStream();
  result.push({ type: "done", reason: "stop", message: response(text) });
  return result;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function fixture(
  options: {
    memory?: boolean;
    initialSessionFile?: string;
    extra?: (pi: ExtensionAPI) => void;
    before?: (pi: ExtensionAPI) => void;
    mode?: ExtensionCommandContext["mode"];
    ui?: Partial<ExtensionUIContext>;
    destinationModel?: Model<Api>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-sessions-test-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    defaultProvider: model.provider,
    defaultModel: model.id,
  });
  let editorText = "original unsent draft";
  const notices: string[] = [];
  const confirmations: string[] = [];
  const editors: Array<{ title: string; prefill: string }> = [];
  const confirmationResults: boolean[] = [];
  const editorResults: Array<string | undefined> = [];
  let source: AgentSession;
  let runtime: AgentSessionRuntime;
  let generationCalls = 0;
  let destinationTurns = 0;
  let withSessions = 0;
  const ui = {
    notify: (text: string) => {
      notices.push(text);
    },
    confirm: async (title: string) => {
      confirmations.push(title);
      return confirmationResults.shift() ?? true;
    },
    editor: async (title: string, prefill?: string) => {
      editors.push({ title, prefill: prefill ?? "" });
      return editorResults.length ? editorResults.shift() : prefill;
    },
    input: async () => "continue goal",
    select: async (_title: string, rows: string[]) => rows[0],
    getEditorText: () => {
      if (options.mode !== "tui") throw new Error("RPC getEditorText must not be called");
      return editorText;
    },
    getEditorComponent: () => undefined,
    setEditorText: (text: string) => {
      editorText = text;
    },
    custom: async () => {
      throw new Error("RPC custom must not be called");
    },
    setFooter: () => {
      throw new Error("Foreign footer must be preserved");
    },
    setEditorComponent: () => {
      throw new Error("Foreign editor must be preserved");
    },
    ...options.ui,
  } as unknown as ExtensionUIContext;
  const factory: CreateAgentSessionRuntimeFactory = async (request) => {
    const services = await createAgentSessionServices({
      cwd: request.cwd,
      agentDir: root,
      settingsManager: settings,
      resourceLoaderOptions: {
        extensionFactories: [
          ...(options.before ? [{ name: "earlier-extension", factory: options.before }] : []),
          {
            name: "sessions-test",
            factory: (pi) => {
              sessions(pi);
              pi.on("agent_start", () => {
                destinationTurns++;
              });
              options.extra?.(pi);
            },
          },
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: request.sessionManager,
      model: source ? (options.destinationModel ?? model) : model,
      noTools: "all",
      sessionStartEvent: request.sessionStartEvent,
    });
    return { ...result, services, diagnostics: [] };
  };
  const manager = options.initialSessionFile
    ? SessionManager.open(options.initialSessionFile)
    : options.memory
      ? SessionManager.inMemory(cwd)
      : SessionManager.create(cwd, join(root, "sessions"));
  if (!options.initialSessionFile) {
    manager.appendMessage({ role: "user", content: "Discuss next steps. api_key=SUPERSECRET", timestamp: 1 });
    manager.appendMessage(response("Decided to retain the public SDK."));
  }
  runtime = await createAgentSessionRuntime(factory, {
    cwd: manager.getCwd(),
    agentDir: root,
    sessionManager: manager,
  });
  source = runtime.session;
  const bind = async (session: AgentSession) => {
    await session.bindExtensions({
      mode: options.mode ?? "rpc",
      uiContext: ui,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (opts) =>
          runtime.newSession({
            ...opts,
            withSession: async (ctx) => {
              withSessions++;
              await opts?.withSession?.(ctx);
            },
          }),
        switchSession: (path, opts) =>
          runtime.switchSession(path, {
            ...opts,
            withSession: async (ctx) => {
              withSessions++;
              await opts?.withSession?.(ctx);
            },
          }),
        fork: (id, opts) => runtime.fork(id, opts),
        navigateTree: async (id, opts) => ({ cancelled: (await session.navigateTree(id, opts)).cancelled }),
        reload: async () => {},
      },
    });
    const registry = session.extensionRunner.createCommandContext().modelRegistry;
    registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "fixture" });
    registry.streamSimple = () => {
      generationCalls++;
      return stream("Generated goal-oriented summary");
    };
  };
  await bind(source);
  runtime.setRebindSession(bind);
  const retained = new Set<string>();
  return {
    root,
    cwd,
    source,
    runtime,
    manager,
    ui,
    notices,
    confirmations,
    editors,
    editorResults,
    confirmationResults,
    get editorText() {
      return editorText;
    },
    set editorText(value: string) {
      editorText = value;
    },
    get generationCalls() {
      return generationCalls;
    },
    get destinationTurns() {
      return destinationTurns;
    },
    get withSessions() {
      return withSessions;
    },
    async command(name: string, args = "") {
      const session = runtime.session;
      const command = session.extensionRunner.getCommand(name);
      if (!command) throw new Error(`Command ${name} missing`);
      await command.handler(args, session.extensionRunner.createCommandContext());
      const header = runtime.session.sessionManager.getHeader();
      if (header?.parentSession?.includes("pi-sessions-parent-")) retained.add(dirname(header.parentSession));
      const file = runtime.session.sessionFile;
      if (file?.includes("pi-sessions-handoff-")) retained.add(dirname(file));
    },
    track(path: string) {
      retained.add(dirname(path));
    },
    async cleanup() {
      await runtime.dispose();
      for (const path of retained) await rm(path, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}
