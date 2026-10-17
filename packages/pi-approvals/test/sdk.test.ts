import fs, { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentSession,
  AgentSessionRuntime,
  createAgentSession,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEventBus,
  createReadTool,
  createWriteTool,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  InteractiveMode,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  type Terminal,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  APPROVAL_ADAPTER_QUERY_CHANNEL,
  APPROVAL_LIFECYCLE_CHANNEL,
  APPROVAL_QUERY_CHANNEL,
  type ApprovalLifecycle,
  captureApprovalService,
  hashBytes,
  queryApprovalService,
  validateAdapterQuery,
  validateLifecycle,
  validateOperation,
  validateQuery,
} from "@signalridge/pi-approval-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalBroker, MAX_PENDING, MAX_RETAINED } from "../src/broker.js";
import approvals from "../src/index.js";
import { confirmOperation, createReviewComponent } from "../src/review.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});
async function fixture(
  later?: (pi: ExtensionAPI) => void,
  mode: "rpc" | "tui" | "print" = "rpc",
  extension = true,
  uiOverride?: Partial<ExtensionUIContext>,
  earlier?: (pi: ExtensionAPI) => void,
  config: { native?: boolean; tools?: string[]; override?: boolean; readOnlyBase?: boolean; paths?: string[] } = {},
) {
  expect(VERSION).toBe("1.0.4");
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "approvals-sdk-")));
  const faux = fauxProvider({ provider: "approval-faux", models: [{ id: "model" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("approval-faux", "model");
  let api: ExtensionAPI | undefined;
  let context: ExtensionContext | undefined;
  const events: ApprovalLifecycle[] = [];
  const errors: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: config.paths,
    extensionFactories: [
      ...(earlier ? [earlier] : []),
      ...(extension ? [approvals] : []),
      ...(later ? [later] : []),
      (pi) => {
        api = pi;
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
        pi.events.on(APPROVAL_LIFECYCLE_CHANNEL, (value) => events.push(validateLifecycle(value)));
      },
    ],
  });
  await loader.reload();
  if (config.native !== false) loader.getExtensions().runtime.flagValues.set("approvals-native-tools", true);
  const manager = SessionManager.inMemory(cwd);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const created = await createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
    tools: config.tools,
  });
  const backendMkdir = vi.fn(async () => {
    throw new Error("custom backend refuses mkdir");
  });
  const backendWrite = vi.fn(async () => {
    throw new Error("custom backend refuses write");
  });
  const override = createWriteTool(cwd, { operations: { mkdir: backendMkdir, writeFile: backendWrite } });
  let session = created.session;
  if (config.override || config.readOnlyBase) {
    session.dispose();
    await loader.reload();
    if (config.native !== false) loader.getExtensions().runtime.flagValues.set("approvals-native-tools", true);
    session = new AgentSession({
      agent: session.agent,
      cwd,
      resourceLoader: loader,
      modelRuntime: runtime,
      sessionManager: manager,
      settingsManager: settings,
      baseToolsOverride: config.readOnlyBase
        ? { read: createReadTool(cwd) }
        : {
            write: override,
            edit: createEditTool(cwd),
            bash: createBashTool(cwd),
          },
    });
  }
  const beforeStartup = api ? queryApprovalService(api.events) : undefined;
  const beforeStartupError = beforeStartup
    ? await beforeStartup.request(operation(cwd), { isCurrent: () => true }).then(
        () => undefined,
        (error: unknown) => error,
      )
    : undefined;
  const baseUI = session.extensionRunner.getUIContext();
  const confirm = vi.fn(async (_title: string, _message: string, _options?: ExtensionUIDialogOptions) => true);
  const custom = vi.fn();
  const customUI: ExtensionUIContext["custom"] = (factory, options) => {
    custom();
    return baseUI.custom(factory, options);
  };
  const notify = vi.fn(baseUI.notify);
  const ui: ExtensionUIContext = { ...baseUI, confirm, custom: customUI, notify, ...uiOverride };
  await session.bindExtensions({
    mode,
    ...(mode === "print" ? {} : { uiContext: ui }),
    onError: (error) => errors.push(error.error),
  });
  cleanups.push(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  if (!api || !context) throw new Error("Missing SDK context");
  const service = queryApprovalService(api.events);
  return {
    session,
    services: {
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      settingsManager: settings,
      resourceLoader: loader,
      diagnostics: [],
    },
    override,
    backendMkdir,
    backendWrite,
    beforeStartup,
    beforeStartupError,
    manager,
    faux,
    cwd,
    api,
    context,
    events,
    errors,
    get service() {
      if (!service) throw new Error("Missing approval service");
      return service;
    },
    confirm,
    custom,
    notify,
    ui,
    getApi: () => {
      if (!api) throw new Error("Missing API");
      return api;
    },
  };
}
async function pending(host: Awaited<ReturnType<typeof fixture>>, count = 1) {
  await vi.waitFor(() => expect(host.events.filter((event) => event.phase === "waiting")).toHaveLength(count));
  return host.events.filter((event) => event.phase === "waiting");
}
it("handles two parallel actual root tool requests individually, with /approvals during a paused turn", async () => {
  const host = await fixture();
  host.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("write", { path: "a", content: "A" }), fauxToolCall("write", { path: "b", content: "B" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write two");
  const requests = await pending(host, 2);
  host.session.setSessionName("parallel rename");
  host.api.appendEntry("parallel ordinary append", { value: 1 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(host.events.filter((event) => event.phase === "resolved")).toEqual([]);
  expect(host.confirm).not.toHaveBeenCalled();
  await host.session.prompt("/approvals", { streamingBehavior: "steer" });
  expect(host.notify).toHaveBeenCalled();
  await host.session.prompt(`/approvals approve ${requests[0].requestId}`, { streamingBehavior: "steer" });
  expect(host.confirm).toHaveBeenCalledOnce();
  expect(host.events.filter((event) => event.phase === "resolved")).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(host.events.filter((event) => event.phase === "resolved")).toHaveLength(1);
  await host.session.prompt(`/approvals deny ${requests[1].requestId}`, { streamingBehavior: "steer" });
  await turn;
  expect(
    host.events
      .filter((event) => event.phase === "resolved")
      .map((event) => event.outcome)
      .sort(),
  ).toEqual(["approved", "denied"]);
  expect(host.errors).toEqual([]);
});
it("revalidates and reviews final late-handler mutations including nested executeTool", async () => {
  const host = await fixture((pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "write") Object.assign(event.input, { content: "late final" });
    });
    pi.registerTool({
      name: "nested",
      label: "nested",
      description: "nested",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal, _update, ctx) => {
        const outcome = await ctx.executeTool("write", { path: "nested", content: "original" }, { signal });
        return outcome.result;
      },
    });
  });
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("nested", {}, { id: "call_nested|fc_nested" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("nested write");
  const [request] = await pending(host);
  expect(request.toolCallId).toBe("call_nested|fc_nested/1");
  await host.session.prompt(`/approvals approve ${request.requestId}`, { streamingBehavior: "steer" });
  await turn;
  expect(host.confirm.mock.calls[0][1]).toContain("late final");
  expect(await readFile(join(host.cwd, "nested"), "utf8")).toBe("late final");
  expect(host.errors).toEqual([]);
});
it("refuses schema corruption by a handler after SDK validation, without a human prompt", async () => {
  const host = await fixture((pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "write") Object.assign(event.input, { content: 42 });
    });
  });
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "file", content: "original" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("invalid write");
  expect(host.events).toEqual([]);
  expect(host.confirm).not.toHaveBeenCalled();
  await expect(readFile(join(host.cwd, "file"))).rejects.toThrow();
});
it("print/no-UI denies bash and write without a process or filesystem mutation", async () => {
  const host = await fixture(undefined, "print");
  host.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("bash", { command: "touch process-marker" }),
        fauxToolCall("write", { path: "missing/dir/file", content: "secret" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("deny no UI");
  expect(host.events).toEqual([]);
  await expect(readFile(join(host.cwd, "process-marker"))).rejects.toThrow();
  await expect(readFile(join(host.cwd, "missing"))).rejects.toThrow();
});
it("retirement on branch navigation/shutdown is sticky for previously captured services", async () => {
  const host = await fixture();
  if (!host.service) throw new Error("missing service");
  const operation = validateOperation({
    kind: "command",
    toolName: "bash",
    source: "test",
    cwd: host.cwd,
    toolCallId: "owned",
    inputHash: hashBytes("true"),
    command: "true",
    preview: "true",
  });
  const call = host.service.request(operation, { isCurrent: () => true });
  const rejected = expect(call).rejects.toThrow();
  await pending(host);
  await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await rejected;
  await expect(host.service.request(operation, { isCurrent: () => true })).rejects.toThrow("unavailable or replaced");
  await expect(host.service.request(operation, { isCurrent: () => true })).rejects.toThrow("retired");
});
it("detects effective earlier custom canonical bindings and later runtime ownership loss", async () => {
  const earlier = await fixture(undefined, "rpc", true, undefined, (pi) => {
    pi.registerTool(createBashToolDefinition("/"));
  });
  expect(earlier.service).toBeDefined();
  await expect(earlier.service?.request(operation(earlier.cwd), { isCurrent: () => true })).rejects.toThrow(
    "unavailable",
  );
  await earlier.session.prompt("/approvals");
  expect(String(earlier.notify.mock.calls[0][0])).toContain("custom canonical bash");
  let foreign: ExtensionAPI | undefined;
  const host = await fixture(undefined, "rpc", true, undefined, (pi) => {
    foreign = pi;
  });
  if (!foreign) throw new Error("Missing foreign runtime");
  foreign.registerTool({ ...createBashToolDefinition(host.cwd), description: "foreign canonical" });
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "touch foreign" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("collision");
  await expect(readFile(join(host.cwd, "foreign"))).rejects.toThrow();
});
it("Plan-style stronger admission is never restored by the approval wrappers", async () => {
  const host = await fixture((pi) => {
    pi.on("session_start", () => {
      pi.setActiveTools(["read"]);
    });
  });
  expect(host.session.getActiveToolNames()).toEqual(["read"]);
});
it("abort closes only owned pending requests; timeout, callback errors, caps and metadata retention are bounded", async () => {
  const host = await fixture(undefined, "rpc", false);
  const broker = new ApprovalBroker(
    host.api.events,
    () => host.context,
    () => true,
    10000,
  );
  const operation = validateOperation({
    kind: "command",
    toolName: "bash",
    source: "test",
    cwd: host.cwd,
    toolCallId: "test",
    inputHash: hashBytes("true"),
    command: "true",
    preview: "true",
  });
  const abort = new AbortController();
  const a = broker.request(operation, { signal: abort.signal, isCurrent: () => true });
  const aRejected = expect(a).rejects.toThrow("cancelled");
  const b = broker.request(operation, { isCurrent: () => true });
  abort.abort();
  await aRejected;
  expect(broker.pending.size).toBe(1);
  await broker.review([...broker.pending.keys()][0], host.context, async () => true);
  await b;
  for (let i = 0; i < MAX_RETAINED + 1; i++) {
    const request = broker.request(operation, { isCurrent: () => true });
    await broker.review([...broker.pending.keys()][0], host.context, async () => true);
    await request;
  }
  expect(broker.retained).toHaveLength(MAX_RETAINED);
  const calls = Array.from({ length: MAX_PENDING }, () =>
    broker.request(operation, { isCurrent: () => true }).catch(() => {}),
  );
  await expect(broker.request(operation, { isCurrent: () => true })).rejects.toThrow("Too many");
  broker.retire();
  await Promise.all(calls);
  expect(broker.pending.size).toBe(0);
  const expired = new ApprovalBroker(
    host.api.events,
    () => host.context,
    () => true,
    1,
  );
  await expect(expired.request(operation, { isCurrent: () => true })).rejects.toThrow("expired");
  const errors = new ApprovalBroker(
    host.api.events,
    () => host.context,
    () => true,
  );
  await expect(
    errors.request(operation, {
      isCurrent: () => {
        throw new Error("owner error");
      },
    }),
  ).rejects.toThrow("owner error");
});
it("missing peer closes captured owned requests and never reconnects; native leaf/manager changes retire", async () => {
  const host = await fixture(undefined, "rpc", false);
  const events = createEventBus();
  const broker = new ApprovalBroker(
    events,
    () => host.context,
    () => true,
  );
  const off = events.on(APPROVAL_QUERY_CHANNEL, (value) => validateQuery(value).respond(broker.service));
  const captured = queryApprovalService(events);
  if (!captured) throw new Error("Missing captured peer");
  const operation = validateOperation({
    kind: "command",
    toolName: "bash_background",
    source: "test",
    cwd: host.cwd,
    toolCallId: "owned",
    inputHash: hashBytes("true"),
    command: "true",
    preview: "true",
  });
  const call = captured.request(operation, { isCurrent: () => true });
  const rejected = expect(call).rejects.toThrow("retired");
  off();
  await rejected;
  expect(broker.pending.size).toBe(0);
  events.on(APPROVAL_QUERY_CHANNEL, (value) => validateQuery(value).respond(broker.service));
  await expect(captured.request(operation, { isCurrent: () => true })).rejects.toThrow("retired");
  const fresh = new ApprovalBroker(
    events,
    () => host.context,
    () => true,
  );
  const pendingCall = fresh.request(operation, { isCurrent: () => true });
  const pendingRejected = expect(pendingCall).rejects.toThrow("retired");
  host.manager.appendCustomEntry("new-native-entry", {});
  host.manager.branch(host.manager.getBranch()[0].id);
  await pendingRejected;
  await expect(fresh.request(operation, { isCurrent: () => true })).rejects.toThrow("retired");
});
it("public reload aborts old service requests and captures a distinct fresh service", async () => {
  const host = await fixture();
  if (!host.service) throw new Error("Missing service");
  const operation = validateOperation({
    kind: "command",
    toolName: "bash",
    source: "test",
    cwd: host.cwd,
    toolCallId: "reload",
    inputHash: hashBytes("true"),
    command: "true",
    preview: "true",
  });
  const request = host.service.request(operation, { isCurrent: () => true });
  const rejected = expect(request).rejects.toThrow();
  await pending(host);
  await host.session.reload();
  await rejected;
  await expect(host.service.request(operation, { isCurrent: () => true })).rejects.toThrow();
  const next = queryApprovalService(host.getApi().events);
  expect(next?.id).not.toBe(host.service.id);
});
it("command-only TUI reviews preserve native focus/draft; arrivals never grab foreign dialog focus", async () => {
  const terminal: Terminal = {
    columns: 100,
    rows: 20,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    drainInput: async () => {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const tui = new TuiMainScreen(terminal);
  const draft = new Text("untouched draft", 0, 0);
  const foreign = new Text("foreign dialog", 0, 0);
  tui.addChild(draft);
  tui.setFocus(foreign);
  const host = await fixture(undefined, "tui");
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "file", content: "after\u202e" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write");
  const [request] = await pending(host);
  expect(tui.getFocusedComponent()).toBe(foreign);
  expect(host.custom).not.toHaveBeenCalled();
  await host.session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
  await host.session.prompt(`/approvals approve ${request.requestId}`, { streamingBehavior: "steer" });
  expect(host.errors.join(" ")).toContain("current");
  expect(tui.getFocusedComponent()).toBe(foreign);
  await host.session.extensionRunner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
  tui.setFocus(draft);
  await host.session.prompt(`/approvals approve ${request.requestId}`, { streamingBehavior: "steer" });
  await turn;
  expect(host.custom).toHaveBeenCalledOnce();
  // The fixture's public no-op custom UI cannot approve; it does not steal focus.
  expect(tui.getFocusedComponent()).toBe(draft);
  expect(draft.render(100).join("\n")).toContain("untouched draft");
  const operation = validateOperation({
    kind: "command",
    toolName: "bash",
    source: "test",
    toolCallId: "screen",
    cwd: host.cwd,
    command: "true",
    inputHash: hashBytes("true"),
    preview: `\\u{202e}\\n${Array.from({ length: 50 }, (_, index) => `Line ${index}`).join("\n")}`,
  });
  const done = vi.fn();
  const component = createReviewComponent(tui, operation, new AbortController().signal, done);
  component.focused = true;
  expect(component.render(100).join("\n")).toContain("\\u{202e}");
  component.handleInput?.("\r");
  expect(done).not.toHaveBeenCalled();
  component.handleInput?.("\x1b[6~");
  expect(component.render(40).join("\n")).toContain("Line 15");
  component.handleInput?.("\x01");
  component.handleInput?.("\x01");
  expect(done).toHaveBeenCalledExactlyOnceWith(true);
  component.dispose();
});

function operation(cwd: string, toolCallId = "owned") {
  return validateOperation({
    kind: "command",
    toolName: "bash_background",
    source: "test",
    cwd,
    toolCallId,
    inputHash: hashBytes("true"),
    command: "true",
    preview: "true",
  });
}
it("a loaded plugin advertises a rejecting service before startup", async () => {
  const host = await fixture();
  expect(host.beforeStartup).toBeDefined();
  expect(host.beforeStartupError).toBeInstanceOf(Error);
  await expect(host.beforeStartup?.request(operation(host.cwd), { isCurrent: () => true })).rejects.toThrow();
});
it("SDK custom base backend is not replaced or executed locally without certification", async () => {
  const host = await fixture(undefined, "rpc", true, undefined, undefined, { native: false, override: true });
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "marker", content: "local" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  let settled = false;
  const turn = host.session.prompt("write").then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(host.events.length > 0 || settled).toBe(true));
  const waiting = host.events.find((item) => item.phase === "waiting");
  if (waiting) await host.session.prompt(`/approvals approve ${waiting.requestId}`, { streamingBehavior: "steer" });
  await turn;
  await expect(readFile(join(host.cwd, "marker"))).rejects.toThrow();
  expect(host.api.getAllTools().find((tool) => tool.name === "write")?.parameters).toBe(host.override.parameters);
  expect(host.backendMkdir.mock.calls.length).toBe(0);
  expect(host.backendWrite.mock.calls.length).toBe(0);
  expect(host.service).toBeDefined();
});
it("two owned requests survive native rename and custom appends", async () => {
  const host = await fixture();
  const calls = [
    host.service?.request(operation(host.cwd, "a"), { isCurrent: () => true }),
    host.service?.request(operation(host.cwd, "b"), { isCurrent: () => true }),
  ];
  const outcomes = calls.map((call) =>
    call.then(
      () => "approved",
      () => "retired",
    ),
  );
  const waiting = await pending(host, 2);
  host.session.setSessionName("renamed");
  host.api.appendEntry("ordinary", { value: 1 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(host.events.filter((item) => item.phase === "resolved")).toEqual([]);
  for (const item of waiting) await host.session.prompt(`/approvals review ${item.requestId}`);
  expect(await Promise.all(outcomes)).toEqual(["approved", "approved"]);
  const third = host.service?.request(operation(host.cwd, "third"), { isCurrent: () => true });
  const thirdOutcome = third.catch(() => {});
  const requests = await pending(host, 3);
  await host.session.prompt(`/approvals review ${requests[2].requestId}`);
  await thirdOutcome;
});
it("actual tree veto keeps pending service usable", async () => {
  const host = await fixture((pi) => pi.on("session_before_tree", () => ({ cancel: true })));
  const target = host.manager.appendCustomEntry("target", {});
  host.manager.appendCustomEntry("later", {});
  const call = host.service?.request(operation(host.cwd), { isCurrent: () => true });
  const outcome = call.then(
    () => "approved",
    () => "retired",
  );
  const [request] = await pending(host);
  expect((await host.session.navigateTree(target)).cancelled).toBe(true);
  await host.session.prompt(`/approvals review ${request.requestId}`);
  expect(await outcome).toBe("approved");
});
it("committed native tree navigation rebinds and permits reviewed write", async () => {
  const host = await fixture();
  const target = host.manager.appendCustomEntry("target", {});
  host.manager.appendCustomEntry("later", {});
  expect((await host.session.navigateTree(target)).cancelled).toBe(false);
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "tree", content: "new" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write");
  const [request] = await pending(host);
  await host.session.prompt(`/approvals review ${request.requestId}`, { streamingBehavior: "steer" });
  await turn;
  expect(await readFile(join(host.cwd, "tree"), "utf8")).toBe("new");
  await expect(host.service?.request(operation(host.cwd), { isCurrent: () => true })).rejects.toThrow();
});
it("actual SDK pipeline accepts OpenAI Responses opaque call identity", async () => {
  const host = await fixture();
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "opaque", content: "new" }, { id: "call_123|fc_456" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write");
  const [request] = await pending(host);
  expect(request.toolCallId).toBe("call_123|fc_456");
  await host.session.prompt(`/approvals review ${request.requestId}`, { streamingBehavior: "steer" });
  await turn;
});
it("late wrappers preserve earlier deactivation despite SDK initial allowlist", async () => {
  const host = await fixture(
    undefined,
    "rpc",
    true,
    undefined,
    (pi) => pi.on("session_start", () => pi.setActiveTools(["read"])),
    { tools: ["read", "write", "bash", "edit"] },
  );
  expect(host.session.getActiveToolNames()).toEqual(["read"]);
});
it("command-shaped uncooperative aliases never execute", async () => {
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: undefined }));
  const host = await fixture((pi) =>
    pi.registerTool({
      name: "hypa_shell",
      label: "hypa_shell",
      description: "alias",
      parameters: Type.Object({ command: Type.String() }),
      execute,
    }),
  );
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hypa_shell", { command: "touch unsafe" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("command");
  expect(execute.mock.calls.length).toBe(0);
});

function terminalFixture(columns = 40, rows = 12) {
  return {
    columns,
    rows,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    drainInput: async () => {},
    write(_data: string) {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}
async function nativeHost(tuiMode: "regular" | "fullscreen" = "regular") {
  const host = await fixture(undefined, "tui");
  initTheme("dark", false);
  const runtime = new AgentSessionRuntime(host.session, host.services, async () => {
    throw new Error("Unexpected replacement");
  });
  const terminal = terminalFixture();
  const mode = new InteractiveMode(runtime, { terminal, tuiMode });
  await mode.init();
  cleanups.push(async () => mode.stop());
  // Inspect the actual host's existing UI context; do not replace its stack or close callback.
  const access = mode as unknown as {
    ui: TuiMainScreen | TuiAltScreen;
    editor: Component;
    createExtensionUIContext(): ExtensionUIContext;
  };
  const ui = access.createExtensionUIContext();
  access.ui.setFocus(access.editor);
  return { host, tui: access.ui, terminal, ui, ctx: { ...host.context, mode: "tui" as const, ui, hasUI: true } };
}
it.each(
  (["regular", "fullscreen"] as const).flatMap((tuiMode) => ["overlay", "confirm"].map((kind) => ({ tuiMode, kind }))),
)("cancellation closes native review before foreign $kind closes ($tuiMode)", async ({ tuiMode, kind }) => {
  const { host, tui, ui, ctx } = await nativeHost(tuiMode);
  ui.setEditorText("untouched draft");
  const abort = new AbortController();
  let aResolved = false;
  const initialFocus = tui.getFocusedComponent();
  const a = confirmOperation(ctx, operation(host.cwd), abort.signal).then((value) => {
    aResolved = true;
    return value;
  });
  await vi.waitFor(() => expect(tui.getFocusedComponent() !== initialFocus).toBe(true));
  const review = tui.getFocusedComponent();
  const b =
    kind === "overlay"
      ? ui.custom<boolean>(
          (_tui, _theme, _keys, done) => ({
            render: () => ["FOREIGN"],
            handleInput: () => done(true),
            invalidate() {},
          }),
          { overlay: true },
        )
      : ui.confirm("FOREIGN", "Still respondable");
  await vi.waitFor(() => expect(tui.getFocusedComponent() !== review).toBe(true));
  const bFocus = tui.getFocusedComponent();
  try {
    // Even a stale input callback cannot approve a review behind foreign focus.
    review?.handleInput?.("\x01");
    await new Promise((resolve) => setImmediate(resolve));
    expect(aResolved).toBe(false);
    abort.abort();
    await vi.waitFor(() => expect(aResolved).toBe(true), { timeout: 300 });
    expect(await a).toBe(false);
    expect(tui.getFocusedComponent() === bFocus).toBe(true);
    expect(ui.getEditorText()).toBe("untouched draft");
  } finally {
    // Also clean up the old, focus-deferred implementation when this probe fails.
    abort.abort();
    bFocus?.handleInput?.("\r");
    expect(await b).toBe(true);
    await a;
  }
  expect(tui.hasOverlay()).toBe(false);
  expect(tui.getFocusedComponent() === initialFocus).toBe(true);
  expect(ui.getEditorText()).toBe("untouched draft");
});
it("review controls/body remain reachable at 40x12 and one-column fallback", () => {
  const terminal = terminalFixture();
  const tui = new TuiMainScreen(terminal);
  const op = { ...operation("/test"), preview: `${Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n")}\n界` };
  const component = createReviewComponent(tui, op, new AbortController().signal, () => {});
  component.focused = true;
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const lines = component.render(40);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    for (const line of lines) seen.add(line.trim());
    component.handleInput?.("\x1b[B");
  }
  for (let i = 0; i < 50; i++) expect(seen.has(`Line ${i}`)).toBe(true);
  terminal.columns = 1;
  component.handleInput?.("\x1b[H");
  let all = "";
  for (let i = 0; i < 1000; i++) {
    const lines = component.render(1);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.every((line) => visibleWidth(line) <= 1)).toBe(true);
    all += lines.join("");
    component.handleInput?.("\x1b[B");
  }
  expect(all).toContain("Ctrl+A");
  expect(all).toContain("Line\\u{20}49"); // Compact preview exposes the space instead of discarding it.
  expect(all).toContain("\\u{754c}");
  component.dispose();
});

it.each([{ tools: [] }, { tools: ["read"] }, { tools: ["write"] }])(
  "partial native admission %j keeps a present service without activating excluded tools",
  async ({ tools }) => {
    const host = await fixture(undefined, "rpc", true, undefined, undefined, { tools });
    expect(host.service).toBeDefined();
    expect(
      host.api
        .getAllTools()
        .filter((tool) => ["write", "edit", "bash"].includes(tool.name))
        .map((tool) => tool.name),
    ).toEqual(tools.filter((name) => name === "write"));
    expect(host.session.getActiveToolNames()).toEqual(tools);
    const call = host.service?.request(operation(host.cwd), { isCurrent: () => true });
    const [request] = await pending(host);
    await host.session.prompt(`/approvals review ${request.requestId}`);
    await call;
  },
);
it("uncertified root canonical calls are denied but the shared human service remains functional", async () => {
  const host = await fixture(undefined, "rpc", true, undefined, undefined, { native: false });
  expect(
    host.api
      .getAllTools()
      .filter((tool) => ["write", "edit", "bash"].includes(tool.name))
      .every((tool) => tool.sourceInfo.path.startsWith("builtin:")),
  ).toBe(true);
  host.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("bash", { command: "touch process" }),
        fauxToolCall("write", { path: "directory/file", content: "x" }),
        fauxToolCall("edit", { path: "file", edits: [{ oldText: "x", newText: "y" }] }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("blocked");
  expect(host.events).toEqual([]);
  await expect(readFile(join(host.cwd, "process"))).rejects.toThrow();
  await expect(readFile(join(host.cwd, "directory"))).rejects.toThrow();
  const call = host.service?.request(operation(host.cwd), { isCurrent: () => true });
  const [request] = await pending(host);
  await host.session.prompt(`/approvals review ${request.requestId}`);
  await call;
});
it.each(["switch", "fork"])(
  "actual native %s veto does not retire pending requests or future service",
  async (kind) => {
    const host = await fixture((pi) => {
      pi.on("session_before_switch", () => ({ cancel: true }));
      pi.on("session_before_fork", () => ({ cancel: true }));
    });
    const runtime = new AgentSessionRuntime(host.session, host.services, async () => {
      throw new Error("Unexpected replacement");
    });
    const call = host.service?.request(operation(host.cwd), { isCurrent: () => true });
    const outcome = call.then(
      () => "approved",
      () => "retired",
    );
    const [request] = await pending(host);
    const result = kind === "switch" ? await runtime.switchSession("unused") : await runtime.fork("unused");
    expect(result.cancelled).toBe(true);
    await host.session.prompt(`/approvals review ${request.requestId}`);
    expect(await outcome).toBe("approved");
    const later = host.service?.request(operation(host.cwd, "later"), { isCurrent: () => true });
    const requests = await pending(host, 2);
    await host.session.prompt(`/approvals review ${requests[1].requestId}`);
    await later;
  },
);
it("native aborted tree summarization leaves the original broker usable", async () => {
  let abortSummary = () => {};
  const host = await fixture((pi) =>
    pi.on("session_before_tree", () => {
      abortSummary();
    }),
  );
  const target = host.manager.appendMessage(fauxAssistantMessage("first"));
  host.manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
  host.manager.appendMessage(fauxAssistantMessage("second answer"));
  const leaf = host.manager.getLeafId();
  abortSummary = () => host.session.abortBranchSummary();
  const call = host.service?.request(operation(host.cwd), { isCurrent: () => true });
  const outcome = call.then(
    () => "approved",
    () => "retired",
  );
  const [request] = await pending(host);
  await expect(host.session.navigateTree(target, { summarize: true })).rejects.toMatchObject({ name: "AbortError" });
  expect(host.manager.getLeafId()).toBe(leaf);
  await host.session.prompt(`/approvals review ${request.requestId}`);
  expect(await outcome).toBe("approved");
});
it.each(["none", "valid", "copy", "duplicate", "malformed", "late", "wrong-name", "replaced"])(
  "SDK command admission requires one current synchronous adapter capability: %s",
  async (mode) => {
    const parameters = Type.Object({ command: Type.String() });
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: undefined }));
    const host = await fixture(
      (pi) => {
        pi.registerTool({
          name: "command_adapter",
          label: "command_adapter",
          description: "trusted test adapter",
          parameters,
          execute,
        });
        if (mode === "none") return;
        pi.events.on(APPROVAL_ADAPTER_QUERY_CHANNEL, (value) => {
          const query = validateAdapterQuery(value);
          if (query.toolName !== "command_adapter") return;
          const response = {
            version: mode === "malformed" ? 2 : 1,
            toolName: mode === "wrong-name" ? "other" : query.toolName,
            parameters: mode === "copy" ? structuredClone(parameters) : parameters,
          };
          if (mode === "late") {
            queueMicrotask(() => query.respond(response));
            return;
          }
          query.respond(response);
          if (mode === "duplicate") query.respond(response);
        });
        if (mode === "replaced")
          pi.on("session_start", () => {
            pi.registerTool({
              name: "command_adapter",
              label: "command_adapter",
              description: "replacement",
              parameters: Type.Object({ command: Type.String() }),
              execute,
            });
          });
      },
      "rpc",
      true,
      undefined,
      undefined,
      { native: false },
    );
    host.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("command_adapter", { command: "true" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await host.session.prompt("command");
    expect(execute.mock.calls.length).toBe(mode === "valid" ? 1 : 0);
  },
);
it("unrelated metadata tools are not blanket-blocked", async () => {
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "metadata" }], details: undefined }));
  const host = await fixture((pi) =>
    pi.registerTool({
      name: "metadata",
      label: "metadata",
      description: "metadata",
      parameters: Type.Object({ title: Type.String() }),
      execute,
    }),
  );
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("metadata", { title: "note" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("metadata");
  expect(execute.mock.calls.length).toBe(1);
});
it("actual native human command opens overlay while tool pending and leaves the editor draft intact", async () => {
  const { host, tui, ui } = await nativeHost();
  await host.session.bindExtensions({ mode: "tui", uiContext: ui });
  ui.setEditorText("draft");
  const focus = tui.getFocusedComponent();
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "native-ui", content: "reviewed" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write");
  const [request] = await pending(host);
  expect(tui.getFocusedComponent() === focus).toBe(true);
  const review = host.session.prompt(`/approvals review ${request.requestId}`, { streamingBehavior: "steer" });
  await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
  const component = tui.getFocusedComponent();
  if (!component) throw new Error("Missing native review focus");
  expect(component.render(40).length).toBeLessThanOrEqual(12);
  component.handleInput?.("\x01");
  await review;
  await turn;
  expect(tui.hasOverlay()).toBe(false);
  expect(tui.getFocusedComponent() === focus).toBe(true);
  expect(ui.getEditorText()).toBe("draft");
  expect(await readFile(join(host.cwd, "native-ui"), "utf8")).toBe("reviewed");
});
it.each(["capturing", "nonCapturing"])(
  "human denial cancels only its reviewed request behind a later native overlay (%s)",
  async (kind) => {
    const { host, tui, ui } = await nativeHost();
    await host.session.bindExtensions({ mode: "tui", uiContext: ui });
    const service = queryApprovalService(host.api.events);
    if (!service) throw new Error("Missing native approval service");
    const a = service.request(operation(host.cwd, "a"), { isCurrent: () => true });
    const aDenied = expect(a).rejects.toThrow("denied");
    const b = service.request(operation(host.cwd, "b"), { isCurrent: () => true });
    const bDenied = expect(b).rejects.toThrow("denied");
    const [request, other] = await pending(host, 2);
    const review = host.session.prompt(`/approvals review ${request.requestId}`);
    await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
    const aFocus = tui.getFocusedComponent();
    let focusForeign: (() => void) | undefined;
    const foreign = ui.custom<boolean>(
      (_tui, _theme, _keys, done) => ({
        render: () => ["foreign"],
        handleInput: () => done(true),
        invalidate() {},
      }),
      {
        overlay: true,
        overlayOptions: { nonCapturing: kind === "nonCapturing" },
        onHandle: (handle) => {
          focusForeign = () => handle.focus();
        },
      },
    );
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== aFocus).toBe(kind === "capturing"));
    await vi.waitFor(() => expect(focusForeign).toBeDefined());
    const bFocus = tui.getFocusedComponent();
    await host.session.prompt(`/approvals deny ${request.requestId}`);
    await aDenied;
    if (kind === "capturing") expect(tui.getFocusedComponent() === bFocus).toBe(true);
    else expect(tui.getFocusedComponent() === aFocus).toBe(false);
    expect(host.events.filter((event) => event.phase === "resolved")).toHaveLength(1);
    if (kind === "nonCapturing") {
      expect(tui.hasOverlay()).toBe(true);
      focusForeign?.();
      tui.getFocusedComponent()?.handleInput?.("\r");
    } else bFocus?.handleInput?.("\r");
    expect(await foreign).toBe(true);
    await review;
    expect(tui.hasOverlay()).toBe(false);
    await host.session.prompt(`/approvals deny ${other.requestId}`);
    await bDenied;
  },
);

it.each(["rpc", "print"] as const)(
  "read-only SDK base never admits a late canonical registration (%s)",
  async (mode) => {
    const host = await fixture(undefined, mode, true, undefined, undefined, { readOnlyBase: true });
    expect(host.api.getAllTools().map((tool) => tool.name)).toEqual(["read"]);
    const active = host.session.getActiveToolNames();
    host.api.registerTool(createWriteToolDefinition(host.cwd));
    host.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "late-canonical", content: "unreviewed" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    await host.session.prompt("late write");
    expect(host.events).toEqual([]);
    expect(host.confirm).not.toHaveBeenCalled();
    await expect(readFile(join(host.cwd, "late-canonical"))).rejects.toThrow();
    expect(host.session.getActiveToolNames().filter((name) => name !== "write")).toEqual(active);
  },
);

it.each(["approve", "abort", "deny"])(
  "review %s removes only its identity behind a foreign nonCapturing overlay",
  async (action) => {
    const { host, tui, ui, ctx } = await nativeHost();
    ui.setEditorText("untouched draft");
    const focus = tui.getFocusedComponent();
    const abort = new AbortController();
    const review = confirmOperation(ctx, operation(host.cwd), abort.signal);
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== focus).toBe(true));
    const owned = tui.getFocusedComponent();
    const foreign = new Text("foreign passive", 0, 0);
    const foreignHandle = tui.showOverlay(foreign, { nonCapturing: true });
    expect(tui.getFocusedComponent() === owned).toBe(true);
    if (action === "abort") abort.abort();
    else owned?.handleInput?.(action === "approve" ? "\x01" : "\x1b");
    expect(await review).toBe(action === "approve");
    expect(tui.hasOverlay()).toBe(true);
    // Its identity handle must still address the surviving foreign overlay.
    foreignHandle.focus();
    expect(tui.getFocusedComponent() === foreign).toBe(true);
    foreignHandle.hide();
    expect(tui.hasOverlay()).toBe(false);
    expect(tui.getFocusedComponent() === focus).toBe(true);
    expect(ui.getEditorText()).toBe("untouched draft");
  },
);

it("root optional command schema cannot acquire unreviewed arguments in a later normalizer", async () => {
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: undefined }));
  const host = await fixture((pi) => {
    pi.registerTool({
      name: "normalizing_alias",
      label: "alias",
      description: "alias",
      parameters: Type.Object({ command: Type.Optional(Type.String()) }),
      execute,
    });
    pi.on("tool_call", (event) => {
      if (event.toolName === "normalizing_alias") event.input.command = "late command";
    });
  });
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("normalizing_alias", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await host.session.prompt("normalize");
  expect(execute).not.toHaveBeenCalled();
});

it.each(["shutdown", "binding", "branch"])(
  "post-approval launch guard discovers sticky broker unavailability after %s without a new request",
  async (loss) => {
    let foreign: ExtensionAPI | undefined;
    const host = await fixture(undefined, "rpc", true, undefined, (pi) => {
      foreign = pi;
    });
    const target = host.manager.appendCustomEntry("earlier", {});
    host.manager.appendCustomEntry("later", {});
    const captured = captureApprovalService(host.api.events);
    if (!captured) throw new Error("Missing captured service");
    const approved = captured.service.request(operation(host.cwd), { isCurrent: () => true });
    const [request] = await pending(host);
    await host.session.prompt(`/approvals review ${request.requestId}`);
    await approved;
    expect(host.events.filter((event) => event.phase === "resolved").map((event) => event.outcome)).toEqual([
      "approved",
    ]);
    host.session.setSessionName("ordinary rename after approval");
    host.api.appendEntry("ordinary append after approval", {});
    expect(() => captured.assertCurrent()).not.toThrow();
    const leaf = host.manager.getLeafId();
    if (!leaf) throw new Error("Missing native leaf");
    if (loss === "shutdown") await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    else if (loss === "binding") {
      if (!foreign) throw new Error("Missing foreign runtime");
      foreign.registerTool({ ...createBashToolDefinition(host.cwd), description: "foreign replacement" });
      expect(host.api.getAllTools().find((tool) => tool.name === "bash")?.description).toBe("foreign replacement");
    } else host.manager.branch(target);

    // No pending-request monitor remains: discovery itself must observe the loss.
    expect(() => captured.assertCurrent()).toThrow();
    const unavailable = queryApprovalService(host.api.events);
    expect(unavailable).toBeDefined();
    expect(unavailable?.id).not.toBe(captured.service.id);
    await expect(unavailable?.request(operation(host.cwd), { isCurrent: () => true })).rejects.toThrow("unavailable");
    if (loss === "branch") host.manager.branch(leaf);
    expect(queryApprovalService(host.api.events)?.id).toBe(unavailable?.id);
    expect(() => captured.assertCurrent()).toThrow("retired");
    await expect(captured.service.request(operation(host.cwd), { isCurrent: () => true })).rejects.toThrow("retired");
    expect(host.events.filter((event) => event.phase === "waiting")).toHaveLength(1);
  },
);

it.each(
  (["regular", "fullscreen"] as const).flatMap((tuiMode) =>
    ["overlay", "confirm"].flatMap((kind) =>
      ["cancelled", "denied", "expired", "retired"].map((outcome) => ({ tuiMode, kind, outcome })),
    ),
  ),
)(
  "broker $outcome review settles and releases its lock behind foreign $kind ($tuiMode)",
  async ({ tuiMode, kind, outcome }) => {
    const { host, tui, ui, ctx } = await nativeHost(tuiMode);
    ui.setEditorText("untouched broker draft");
    const initialFocus = tui.getFocusedComponent();
    const broker = new ApprovalBroker(
      host.api.events,
      () => ctx,
      () => true,
      outcome === "expired" ? 500 : 5000,
    );
    const abort = new AbortController();
    const request = broker.request(operation(host.cwd, "first"), { signal: abort.signal, isCurrent: () => true });
    const result = request.then(
      () => "approved",
      (error: unknown) => String(error),
    );
    const id = [...broker.pending.keys()][0];
    let settled = false;
    const review = broker
      .review(id, ctx, (op, signal) => confirmOperation(ctx, op, signal))
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== initialFocus).toBe(true));
    const owned = tui.getFocusedComponent();
    const foreign =
      kind === "overlay"
        ? ui.custom<boolean>(
            (_tui, _theme, _keys, done) => ({
              render: () => ["FOREIGN"],
              handleInput: () => done(true),
              invalidate() {},
            }),
            { overlay: true },
          )
        : ui.confirm("FOREIGN", "Still respondable");
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== owned).toBe(true));
    const foreignFocus = tui.getFocusedComponent();
    try {
      if (outcome === "cancelled") abort.abort();
      else if (outcome === "denied") await broker.review(id, ctx, async () => true, true);
      else if (outcome === "retired") broker.retire();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
      await review;
      expect(await result).toContain(outcome);
      expect(tui.getFocusedComponent() === foreignFocus).toBe(true);
      expect(ui.getEditorText()).toBe("untouched broker draft");
      if (outcome !== "retired") {
        const next = broker.request(operation(host.cwd, "next"), { isCurrent: () => true });
        const nextResult = next.then(
          () => "approved",
          () => "rejected",
        );
        // This fails if the invocation-global reviewing lock outlives cancellation.
        await broker.review([...broker.pending.keys()][0], ctx, async () => true);
        expect(await nextResult).toBe("approved");
        expect(tui.getFocusedComponent() === foreignFocus).toBe(true);
      }
    } finally {
      broker.retire();
      foreignFocus?.handleInput?.("\r");
      expect(await foreign).toBe(true);
      await review;
      await result;
    }
    expect(tui.hasOverlay()).toBe(false);
    expect(tui.getFocusedComponent() === initialFocus).toBe(true);
    expect(ui.getEditorText()).toBe("untouched broker draft");
  },
);

it.each(["regular", "fullscreen"] as const)(
  "abort during overlay admission removes the late admitted review (%s)",
  async (tuiMode) => {
    const { host, tui, ui, ctx } = await nativeHost(tuiMode);
    ui.setEditorText("admission draft");
    const initialFocus = tui.getFocusedComponent();
    const abort = new AbortController();
    let admitted: ReturnType<typeof tui.showOverlay> | undefined;
    let owned: Component | undefined;
    const admission = vi.fn((...args: Parameters<typeof tui.showOverlay>) => {
      owned = args[0];
      abort.abort();
      admitted = tui.showOverlay(...args);
      return admitted;
    });
    const custom: ExtensionUIContext["custom"] = (factory, options) =>
      ui.custom(
        (native, theme, keys, done) =>
          factory(
            new Proxy(native, {
              get(target, key) {
                return key === "showOverlay" ? admission : Reflect.get(target, key);
              },
            }),
            theme,
            keys,
            done,
          ),
        options,
      );
    let settled = false;
    const review = confirmOperation({ ...ctx, ui: { ...ui, custom } }, operation(host.cwd), abort.signal).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    try {
      await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce(), { timeout: 300 });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300 });
      expect(await review).toBe(false);
      expect(tui.hasOverlay()).toBe(false);
      expect(tui.getFocusedComponent() === initialFocus).toBe(true);
      expect(ui.getEditorText()).toBe("admission draft");
    } finally {
      // Bound the regression probe even if admission or completion regresses.
      admitted?.focus();
      owned?.handleInput?.("\x1b");
      await new Promise((resolve) => setImmediate(resolve));
      admitted?.hide();
    }
  },
);

function hold() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it.each(["shutdown", "replacement", "branch"])("C: root held post-approval file recheck denies %s", async (loss) => {
  const host = await fixture();
  const entered = hold(),
    release = hold();
  let approved = false;
  host.api.events.on(APPROVAL_LIFECYCLE_CHANNEL, (value) => {
    const event = validateLifecycle(value);
    if (event.phase === "resolved" && event.outcome === "approved") approved = true;
  });
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    if (approved) {
      entered.resolve();
      await release.promise;
    }
    return lstat(...args);
  });
  syncBuiltinESMExports();
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "held/new/file", content: "never" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write");
  const [request] = await pending(host);
  await host.session.prompt(`/approvals approve ${request.requestId}`, { streamingBehavior: "steer" });
  await entered.promise;
  if (loss === "shutdown") await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  else if (loss === "replacement")
    host.api.events.on(APPROVAL_QUERY_CHANNEL, (v) =>
      validateQuery(v).respond({ version: 1, id: "replacement", request: async () => {} }),
    );
  else host.manager.resetLeaf();
  release.resolve();
  await turn;
  await expect(fs.stat(join(host.cwd, "held"))).rejects.toThrow();
  expect(host.events.filter((e) => e.phase === "waiting")).toHaveLength(1);
});
it("D: actual Plan start withdraws a pending ordinary root write", async () => {
  const host = await fixture(undefined, "rpc", true, undefined, undefined, {
    paths: [fileURLToPath(new URL("../../pi-plan-mode", import.meta.url))],
  });
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "ordinary/file", content: "never" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const turn = host.session.prompt("write");
  const [request] = await pending(host);
  await host.session.prompt("/plan start", { streamingBehavior: "steer" });
  expect(host.session.getActiveToolNames()).not.toContain("write");
  await host.session.prompt(`/approvals approve ${request.requestId}`, { streamingBehavior: "steer" });
  await turn;
  await expect(fs.stat(join(host.cwd, "ordinary"))).rejects.toThrow();
  expect(host.events.filter((e) => e.phase === "waiting")).toHaveLength(1);
});
it.each(["regular", "fullscreen"] as const)(
  "F: native large paste, cursor and Undo survive review (%s)",
  async (mode) => {
    const { host, tui, ui } = await nativeHost(mode);
    await host.session.bindExtensions({ mode: "tui", uiContext: ui });
    const editor = tui.getFocusedComponent();
    if (!editor) throw new Error("No editor");
    editor.handleInput?.("prefix ");
    const pasted = "large payload ".repeat(2000);
    editor.handleInput?.(`\x1b[200~${pasted}\x1b[201~`);
    editor.handleInput?.("\x1b[D");
    const draft = ui.getEditorText();
    const rows = editor.render(40);
    const service = queryApprovalService(host.api.events);
    if (!service) throw new Error("Missing peer");
    const approved = service.request(operation(host.cwd), { isCurrent: () => true });
    const denied = expect(approved).rejects.toThrow("denied");
    const [request] = await pending(host);
    const review = host.session.prompt(`/approvals review ${request.requestId}`);
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== editor).toBe(true));
    tui.getFocusedComponent()?.handleInput?.("\x1b");
    await review;
    await denied;
    expect(ui.getEditorText()).toBe(draft);
    expect(editor.render(40)).toEqual(rows);
    editor.handleInput?.("X");
    // Native large-paste placeholders move atomically: Left crosses the paste.
    expect(ui.getEditorText()).toBe(`prefix X${pasted}`);
    editor.handleInput?.("\x1f");
    expect(ui.getEditorText()).toBe(draft);
    editor.handleInput?.("\x1f");
    expect(ui.getEditorText()).toBe("prefix ");
  },
);
it.each(
  (["regular", "fullscreen"] as const).flatMap((mode) =>
    [
      [40, 12],
      [80, 24],
    ].flatMap(([columns, rows]) => ["confirm", "select", "input"].map((kind) => ({ mode, columns, rows, kind }))),
  ),
)(
  "G: composed foreign $kind visible before review cancellation ($mode $columns x $rows)",
  async ({ mode, columns, rows, kind }) => {
    const { host, tui, ui, ctx, terminal } = await nativeHost(mode);
    terminal.columns = columns;
    terminal.rows = rows;
    const initial = tui.getFocusedComponent();
    const abort = new AbortController();
    const review = confirmOperation(
      ctx,
      { ...operation(host.cwd), preview: "OWNED REVIEW ROW\n".repeat(80) },
      abort.signal,
    );
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== initial).toBe(true));
    const owned = tui.getFocusedComponent();
    const question =
      kind === "confirm"
        ? ui.confirm("FOREIGN QUESTION", "Answer this question")
        : kind === "select"
          ? ui.select("FOREIGN QUESTION", ["CHOICE ONE", "CHOICE TWO"])
          : ui.input("FOREIGN QUESTION", "TYPE ANSWER");
    await vi.waitFor(() => expect(tui.getFocusedComponent() !== owned).toBe(true));
    const foreign = tui.getFocusedComponent();
    try {
      tui.renderNow();
      const frame =
        tui instanceof TuiAltScreen
          ? tui.getScreenLines()
          : (() => {
              const state = tui.captureRenderState();
              return state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + rows);
            })();
      const text = frame.map(stripTerminalSequences).join("\n");
      const evidence = process.env.PI_APPROVAL_UI_EVIDENCE;
      if (evidence)
        await fs.appendFile(
          evidence,
          `${JSON.stringify({ mode, columns, rows, kind, phase: "foreign-pending", lines: frame.map(stripTerminalSequences) })}\n`,
        );
      expect(text).toContain("FOREIGN QUESTION");
      expect(text).not.toContain("OWNED REVIEW ROW");
      if (kind === "input") foreign?.handleInput?.("typed answer");
      foreign?.handleInput?.("\r");
      expect(await question).toBe(kind === "confirm" ? true : kind === "select" ? "CHOICE ONE" : "typed answer");
      await new Promise((r) => setImmediate(r));
      expect(tui.getFocusedComponent()).toBe(owned);
      tui.renderNow();
      expect(owned?.render(columns).join("\n")).toContain("OWNED REVIEW ROW");
      const resumed =
        tui instanceof TuiAltScreen
          ? tui.getScreenLines()
          : (() => {
              const state = tui.captureRenderState();
              return state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + rows);
            })();
      expect(resumed.map(stripTerminalSequences).join("\n")).toContain("OWNED REVIEW ROW");
      if (evidence)
        await fs.appendFile(
          evidence,
          `${JSON.stringify({ mode, columns, rows, kind, phase: "review-resumed", lines: resumed.map(stripTerminalSequences) })}\n`,
        );
    } finally {
      abort.abort();
      foreign?.handleInput?.("\x1b");
      await question;
      await review;
    }
    expect(tui.hasOverlay()).toBe(false);
  },
);

it.each(
  (["regular", "fullscreen"] as const).flatMap((mode) =>
    [
      { columns: 1, preview: "का", codes: ["915", "93e"] },
      { columns: 2, preview: "काि", codes: ["915", "93e", "93f"] },
    ].map((sample) => ({ mode, ...sample })),
  ),
)(
  "oversized grapheme remains inspectable in composed $columns-column review ($mode)",
  async ({ mode, columns, preview, codes }) => {
    const { host, tui, terminal } = await nativeHost(mode);
    terminal.columns = columns;
    terminal.rows = 12;
    expect(visibleWidth(preview)).toBeGreaterThan(columns);
    const component = createReviewComponent(
      tui,
      { ...operation(host.cwd), preview },
      new AbortController().signal,
      () => {},
    );
    const handle = tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
    try {
      tui.renderNow();
      component.handleInput?.("\x1b[F");
      tui.renderNow();
      const frame =
        tui instanceof TuiAltScreen
          ? tui.getScreenLines()
          : (() => {
              const state = tui.captureRenderState();
              return state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + terminal.rows);
            })();
      const text = frame.map(stripTerminalSequences).join("");
      expect(frame.every((line) => visibleWidth(line) <= columns)).toBe(true);
      for (const code of codes) expect(text).toContain(code);
      expect(preview).toBe(columns === 1 ? "का" : "काि");
    } finally {
      handle.hide();
      component.dispose();
      tui.stop();
    }
  },
);

it.each(
  (["regular", "fullscreen"] as const).flatMap((mode) =>
    [1, 2].flatMap((columns) => [
      { mode, columns, name: "space", first: "echo का का", second: "echo काका" },
      { mode, columns, name: "newline", first: "echo का\nका", second: "echo काका" },
      { mode, columns, name: "literal escape", first: "echo a b", second: "echo a\\u{20}b" },
    ]),
  ),
)(
  "compact composed review distinguishes $name across scrolling ($mode $columns columns)",
  async ({ mode, columns, first, second }) => {
    const { host, tui, terminal } = await nativeHost(mode);
    terminal.columns = columns;
    terminal.rows = 12;
    const inspect = (command: string): string => {
      const op = { ...operation(host.cwd), command, preview: command, inputHash: hashBytes(command) };
      const component = createReviewComponent(tui, op, new AbortController().signal, () => {});
      const handle = tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      const frames: string[][] = [];
      try {
        for (let i = 0; i < 256; i++) {
          tui.renderNow();
          const frame =
            tui instanceof TuiAltScreen
              ? tui.getScreenLines()
              : (() => {
                  const state = tui.captureRenderState();
                  return state.previousLines.slice(
                    state.previousViewportTop,
                    state.previousViewportTop + terminal.rows,
                  );
                })();
          frames.push(frame.map(stripTerminalSequences));
          component.handleInput?.("\x1b[B");
        }
        expect(op.command).toBe(command);
        expect(op.preview).toBe(command);
        return JSON.stringify(frames);
      } finally {
        handle.hide();
        component.dispose();
      }
    };
    try {
      expect(inspect(first) === inspect(second)).toBe(false);
    } finally {
      tui.stop();
    }
  },
);

it.each(
  (["regular", "fullscreen"] as const).flatMap((mode) =>
    [2, 80].flatMap((columns) => [
      { mode, columns, name: "Thai", base: "\u0e01", composed: "\u0e33", decomposed: "\u0e4d\u0e32", code: "e33" },
      { mode, columns, name: "Lao", base: "\u0e81", composed: "\u0eb3", decomposed: "\u0ecd\u0eb2", code: "eb3" },
    ]),
  ),
)(
  "native output distinguishes $name AM source representations ($mode $columns columns)",
  async ({ mode, columns, base, composed, decomposed, code }) => {
    const { host, tui, terminal } = await nativeHost(mode);
    terminal.columns = columns;
    terminal.rows = 12;
    const writes: string[] = [];
    vi.spyOn(terminal, "write").mockImplementation((data) => {
      writes.push(data);
    });
    const inspect = (suffix: string): string => {
      const command = `echo ${base}${suffix}`;
      const op = { ...operation(host.cwd), command, preview: command, inputHash: hashBytes(command) };
      const component = createReviewComponent(tui, op, new AbortController().signal, () => {});
      const handle = tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      try {
        tui.renderNow(true);
        component.handleInput?.("\x1b[F");
        writes.length = 0;
        tui.renderNow(true);
        expect(op.command).toBe(command);
        expect(op.preview).toBe(command);
        // Capture actual native terminal writes AFTER output normalization, not
        // just pre-normalization getScreenLines/captureRenderState snapshots.
        return stripTerminalSequences(writes.join("")).replace(/[\r\n]/gu, "");
      } finally {
        handle.hide();
        component.dispose();
      }
    };
    try {
      const first = inspect(composed);
      const second = inspect(decomposed);
      expect(first === second).toBe(false);
      expect(first).toContain(`\\u{${code}}`);
      expect(first).not.toContain(composed);
    } finally {
      tui.stop();
    }
  },
);
