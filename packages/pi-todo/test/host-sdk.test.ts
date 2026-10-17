import fs, { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import todo from "../src/extension.js";
import { CONTEXT_TYPE, type Params, type Snapshot, STATE_TYPE } from "../src/state.js";
import { OwnedOverlay } from "../src/ui.js";
import { terminalFixture } from "./terminal.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
  options: {
    before?: (pi: ExtensionAPI) => void;
    after?: (pi: ExtensionAPI) => void;
    terminal?: ReturnType<typeof terminalFixture>;
    mode?: "rpc" | "print";
    tools?: string[] | null;
    expectedLoadCollision?: boolean;
    fileBacked?: boolean;
  } = {},
) {
  expect(["1.0.4", "1.1.0"]).toContain(VERSION);
  const cwd = mkdtempSync(join(tmpdir(), "todo-sdk-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  });
  const faux = fauxProvider({ provider: "todo-test", models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("todo-test", "fixture");
  if (!model) throw new Error("Missing test model");
  let api!: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noContextFiles: true,
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
  if (options.expectedLoadCollision)
    expect(loader.getExtensions().errors).toEqual([
      expect.objectContaining({ error: expect.stringContaining('Tool "todo" conflicts') }),
    ]);
  else expect(loader.getExtensions().errors).toEqual([]);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  let { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: options.fileBacked
      ? SessionManager.create(cwd, join(cwd, "sessions"))
      : SessionManager.inMemory(cwd),
    settingsManager,
    ...(options.tools === null ? {} : { tools: options.tools ?? ["todo", "nested"] }),
  });
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
    faux.setResponses([]);
  });
  const errors: string[] = [];
  await session.bindExtensions({
    onError: (error) => errors.push(String(error)),
    ...(options.terminal
      ? { mode: "tui" as const, uiContext: options.terminal.ui }
      : { mode: options.mode ?? "print" }),
  });
  const host = new AgentSessionRuntime(
    session,
    { cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, diagnostics: [] },
    async ({ sessionManager, sessionStartEvent }) => {
      await loader.reload();
      const result = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager,
        sessionStartEvent,
        settingsManager,
        ...(options.tools === null ? {} : { tools: options.tools ?? ["todo", "nested"] }),
      });
      return {
        ...result,
        services: { cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, diagnostics: [] },
        diagnostics: [],
      };
    },
  );
  host.setRebindSession(async (replacement) => {
    session = replacement;
    await session.bindExtensions({
      onError: (error) => errors.push(String(error)),
      ...(options.terminal
        ? { mode: "tui" as const, uiContext: options.terminal.ui }
        : { mode: options.mode ?? "print" }),
    });
  });
  const call = async (params: Params, callId = crypto.randomUUID()) => {
    const runner = session.extensionRunner;
    const blocked = await runner.emitToolCall({
      type: "tool_call",
      toolName: "todo",
      toolCallId: callId,
      input: params,
    });
    if (blocked?.block) throw new Error(blocked.reason);
    const tool = runner.getToolDefinition("todo");
    if (!tool) throw new Error("Missing todo tool");
    return tool.execute(callId, params, undefined, undefined, runner.createToolContext(callId, undefined));
  };
  return {
    get session() {
      return session;
    },
    faux,
    get api() {
      return api;
    },
    loader,
    errors,
    call,
    host,
  };
}

for (const mode of ["print", "rpc"] as const)
  describe(`real SDK ${mode}`, () => {
    it("runs the tool pipeline without custom UI, persists explicit entries and supplies model-visible full state once", async () => {
      const f = await fixture({ mode });
      const probe = vi.fn(() => fauxAssistantMessage("Acknowledged."));
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("todo", { action: "add", baseRevision: 0, title: "SDK task" }), {
          stopReason: "toolUse",
        }),
        probe,
      ]);
      await f.session.prompt("Track this explicit task.");
      const result = f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "todo");
      expect(result).toMatchObject({ isError: false, details: { revision: 1, tasks: [{ title: "SDK task" }] } });
      expect(
        f.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === STATE_TYPE),
      ).toHaveLength(1);
      const seen = JSON.stringify(probe.mock.calls);
      expect(seen).toContain("SDK task");
      expect(seen.match(/Current session\/branch checklist/g) ?? []).toHaveLength(1); // Compact mutation result; context supplies full state once.
      if (result?.role !== "toolResult") throw new Error("Missing Todo result");
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"changedCount":1') });
      expect(result.content[0]).not.toMatchObject({ text: expect.stringContaining('"tasks"') });
      await f.session.prompt("/todo"); // Hint only, no model request and no mutation.
      expect(
        f.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === STATE_TYPE),
      ).toHaveLength(1);
      expect(f.errors).toEqual([]);
    });
  });

describe("real host ownership and context", () => {
  it("quarantines orphaned native ancestry after prompt-driven EIO and automatic tool-result persistence on reopen", async () => {
    const f = await fixture({ fileBacked: true });
    f.faux.setResponses([fauxAssistantMessage("Started.")]);
    await f.session.prompt("Ordinary persisted conversation.");
    const first = await f.call({ action: "add", baseRevision: 0, title: "Keep durable state" });
    const ancestor = f.session.sessionManager.getLeafId();
    const file = f.session.sessionManager.getSessionFile();
    if (!file || !ancestor) throw new Error("Missing native checkpoint");
    const nativeAppend = fs.appendFileSync;
    const fault = vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
      if (args[0] === file && String(args[1]).includes(`"customType":"${STATE_TYPE}"`))
        throw Object.assign(new Error("native EIO"), { code: "EIO" });
      nativeAppend(...args);
    });
    syncBuiltinESMExports();
    try {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("todo", { action: "clear", baseRevision: 1 }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Write failed."),
      ]);
      await f.session.prompt("Clear the checklist.");
      expect(f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "todo")).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("native EIO") }],
      });
    } finally {
      fault.mockRestore();
      syncBuiltinESMExports();
    }
    const diskBeforeReopen = fs.readFileSync(file, "utf8");
    expect(diskBeforeReopen).not.toContain('"revision":2');
    expect(diskBeforeReopen).toContain('"role":"toolResult"');
    expect(await f.host.switchSession(file)).toMatchObject({ cancelled: false });
    const diskAfterReopen = fs.readFileSync(file, "utf8");
    expect(diskAfterReopen.startsWith(diskBeforeReopen)).toBe(true); // SDK may append native settings on open.
    const branch = f.session.sessionManager.getBranch();
    const missing = branch[0]?.parentId;
    expect(missing).toBeTypeOf("string");
    expect(f.session.sessionManager.getEntries().some((entry) => entry.id === missing)).toBe(false);
    expect(branch.some((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)).toBe(false);
    // Previously list silently succeeded with revision 0 and no tasks here.
    await expect(f.call({ action: "list" })).rejects.toThrow(/unavailable/i);
    await expect(f.call({ action: "add", baseRevision: 0, title: "Must not replace lost ancestry" })).rejects.toThrow(
      /unavailable/i,
    );
    const context = await f.session.extensionRunner.emitContext([]);
    expect(JSON.stringify(context)).toContain("no authoritative checklist supplied");
    expect(JSON.stringify(context)).not.toContain('"revision"');
    expect(fs.readFileSync(file, "utf8")).toBe(diskAfterReopen); // Todo never repairs native persistence.
    await f.session.navigateTree(ancestor); // Explicit public navigation, not recovery from an unrelated branch.
    expect((await f.call({ action: "list" })).details).toEqual(first.details);
    expect((await f.call({ action: "clear", baseRevision: 1 })).details).toMatchObject({ revision: 2, tasks: [] });
  });
  it("injects full current context once for compact mutations, never for an exact list result, and never persists context", async () => {
    const f = await fixture();
    const changed = await f.call({ action: "add", baseRevision: 0, title: "Current full task" });
    expect(changed.content[0]).toMatchObject({ text: expect.stringContaining('"changedCount":1') });
    expect(Object.isFrozen(changed.details)).toBe(true);
    expect(Object.isFrozen(changed.structuredContent)).toBe(true);
    const runner = f.session.extensionRunner;
    const first = await runner.emitContext([]);
    const second = await runner.emitContext(first);
    const own = second.filter((m) => m.role === "custom" && m.customType === CONTEXT_TYPE);
    expect(own).toHaveLength(1);
    expect(JSON.stringify(own)).toContain("in-memory, not persistent after process exit");
    expect(JSON.stringify(own)).toContain("Current full task");
    const list = await f.call({ action: "list" });
    const withList = await runner.emitContext([
      ...second,
      {
        role: "toolResult",
        toolName: "todo",
        toolCallId: "list",
        content: list.content,
        details: list.details as Snapshot,
        isError: false,
        timestamp: 1,
      },
    ]);
    expect(withList.filter((m) => m.role === "custom" && m.customType === CONTEXT_TYPE)).toHaveLength(0);
    expect(
      f.session.sessionManager.getBranch().some((e) => e.type === "custom_message" && e.customType === CONTEXT_TYPE),
    ).toBe(false);
  });
  it("rejects a fresh Todo mutation before append after ordinary-message EIO and reload retaining the manager", async () => {
    const f = await fixture({ fileBacked: true });
    f.faux.setResponses([fauxAssistantMessage("Started.")]);
    await f.session.prompt("Ordinary persisted conversation.");
    const first = await f.call({ action: "add", baseRevision: 0, title: "Keep durable state" });
    const manager = f.session.sessionManager;
    const file = manager.getSessionFile();
    if (!file) throw new Error("Missing native file");
    const before = fs.readFileSync(file, "utf8");
    const fault = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ordinary message EIO"), { code: "EIO" });
    });
    syncBuiltinESMExports();
    try {
      expect(() => manager.appendMessage({ role: "user", content: "Failed ordinary append", timestamp: 2 })).toThrow(
        "EIO",
      );
    } finally {
      fault.mockRestore();
      syncBuiltinESMExports();
    }
    const ghost = manager.getBranch().at(-1);
    expect(ghost).toMatchObject({ type: "message", message: { content: "Failed ordinary append" } });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    await f.session.reload();
    expect(f.session.sessionManager).toBe(manager);
    expect(manager.getBranch().at(-1)).toBe(ghost);
    expect((await f.call({ action: "list" })).details).toEqual(first.details);
    const append = vi.spyOn(manager, "appendCustomEntry");
    const mutation = await f.call({ action: "clear", baseRevision: 1 }).then(
      (result) => ({ result: result.details, error: "" }),
      (error: unknown) => ({ result: undefined, error: String(error) }),
    );
    const appendCount = append.mock.calls.length;
    const leafAfterMutation = manager.getBranch().at(-1);
    const retained = (await f.call({ action: "list" })).details;
    const diskAfterMutation = fs.readFileSync(file, "utf8");
    append.mockRestore();
    expect(await f.host.switchSession(file)).toMatchObject({ cancelled: false });
    const reopen = await f.call({ action: "list" }).then(
      (result) => ({ result: result.details, error: "" }),
      (error: unknown) => ({ result: undefined, error: String(error) }),
    );
    // Collect the actual reopen outcome even when running this regression against the broken implementation.
    if (process.env.PI_TODO_DURABILITY_EVIDENCE)
      fs.appendFileSync(
        process.env.PI_TODO_DURABILITY_EVIDENCE,
        `${JSON.stringify({ mutation, appendCount, retained, diskUnchanged: diskAfterMutation === before, reopen })}\n`,
      );
    expect(mutation.error).toMatch(/uncommitted.*native|uncommitted.*ancestor/i);
    expect(appendCount).toBe(0);
    expect(leafAfterMutation).toBe(ghost);
    expect(retained).toEqual(first.details);
    expect(diskAfterMutation).toBe(before); // No orphan Todo record was written.
    expect(reopen).toEqual({ result: first.details, error: "" });
    expect((await f.call({ action: "clear", baseRevision: 1 })).details).toMatchObject({ revision: 2, tasks: [] });
    expect(f.errors).toEqual([]);
  });
  it("native EIO ghosts stay out of authoritative context and reload recovery until actual file reopen", async () => {
    const f = await fixture({ fileBacked: true });
    f.faux.setResponses([fauxAssistantMessage("Started.")]);
    await f.session.prompt("Ordinary persisted conversation.");
    const first = await f.call({ action: "add", baseRevision: 0, title: "Keep durable state" });
    const file = f.session.sessionManager.getSessionFile();
    if (!file) throw new Error("Missing native file");
    const nativeAppend = fs.appendFileSync;
    const fault = vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
      if (args[0] === file && String(args[1]).includes(STATE_TYPE)) throw new Error("native EIO");
      nativeAppend(...args);
    });
    syncBuiltinESMExports();
    try {
      await expect(f.call({ action: "clear", baseRevision: 1 })).rejects.toThrow("native EIO");
      expect(f.session.sessionManager.getBranch().at(-1)).toMatchObject({ data: { revision: 2, tasks: [] } });
      const context = await f.session.extensionRunner.emitContext([]);
      expect(JSON.stringify(context)).toContain("no authoritative checklist supplied");
      expect(JSON.stringify(context)).not.toContain('"revision"');
    } finally {
      fault.mockRestore();
      syncBuiltinESMExports();
    }
    await f.session.reload(); // Reload retains the manager, including its failed-write native ghost.
    expect((await f.call({ action: "list" })).details).toEqual(first.details);
    await expect(f.call({ action: "clear", baseRevision: 1 })).rejects.toThrow("uncommitted state entry");
    expect(await f.host.switchSession(file)).toMatchObject({ cancelled: false }); // Actual public file reopen.
    expect((await f.call({ action: "list" })).details).toEqual(first.details);
    expect((await f.call({ action: "clear", baseRevision: 1 })).details).toMatchObject({ revision: 2, tasks: [] });
    expect(f.errors).toEqual([]);
  });
  it("validates mutation revisions and Unicode bounds in the actual model argument pipeline", async () => {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo", { action: "add", title: "Missing revision" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Rejected."),
    ]);
    await f.session.prompt("Invalid arguments should fail.");
    expect(f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "todo")).toMatchObject({
      isError: true,
    });
    expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 0, tasks: [] });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo", { action: "add", baseRevision: 0, title: "😀".repeat(160) }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Accepted."),
    ]);
    await f.session.prompt("Valid Unicode title.");
    const result = [...f.session.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "todo");
    expect(result).toMatchObject({ isError: false, details: { revision: 1 } });
    expect(f.errors).toEqual([]);
  });
  for (const fileBacked of [false, true])
    it(`persists nested calls (${fileBacked ? "file" : "memory"}), reload/compaction and explicit empty snapshots`, async () => {
      const f = await fixture({
        fileBacked,
        after: (pi) => {
          pi.registerTool({
            name: "nested",
            label: "nested",
            description: "test nested call",
            parameters: { type: "object", properties: {} },
            async execute(_id, _args, _signal, _update, ctx) {
              const result = await ctx.executeTool("todo", {
                action: "add",
                baseRevision: 0,
                title: "Nested durable task",
              });
              if (result.isError) throw new Error(JSON.stringify(result));
              return {
                content: [{ type: "text", text: "Nested call succeeded; result omitted." }],
                details: undefined,
              };
            },
          });
        },
      });
      const afterNested = vi.fn(() => fauxAssistantMessage("Done."));
      f.faux.setResponses([fauxAssistantMessage(fauxToolCall("nested", {}), { stopReason: "toolUse" }), afterNested]);
      await f.session.prompt("Nested work.");
      expect(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === "todo")).toBe(false);
      expect(JSON.stringify(afterNested.mock.calls)).toContain("Nested durable task");
      await f.session.reload();
      expect((await f.call({ action: "list" })).details).toMatchObject({
        revision: 1,
        tasks: [{ title: "Nested durable task" }],
      });
      // Real host compaction with an explicit public extension summary, not a mocked context.
      f.api.on("session_before_compact", (event) => ({
        compaction: {
          summary: "No checklist text in this summary.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      }));
      await f.session.compact();
      const afterCompact = vi.fn(() => fauxAssistantMessage("After compact."));
      f.faux.setResponses([afterCompact]);
      await f.session.prompt("Continue after compact.");
      expect(JSON.stringify(afterCompact.mock.calls)).toContain("Nested durable task");
      await f.call({ action: "clear", baseRevision: 1 });
      await f.session.reload();
      expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 2, tasks: [] });
      const emptyProbe = vi.fn(() => fauxAssistantMessage("Empty confirmed."));
      f.faux.setResponses([emptyProbe]);
      await f.session.prompt("Continue without tasks.");
      expect(JSON.stringify(emptyProbe.mock.calls)).toContain('\\"revision\\":2,\\"tasks\\":[]');
      expect(f.errors).toEqual([]);
    });
  it("rejects parallel stale revisions, failed append, result aliasing, and restores rollback from current branch", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.call({ action: "add", baseRevision: 0, title: "A" }),
      f.call({ action: "add", baseRevision: 0, title: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const first = (await f.call({ action: "list" })).details as Snapshot;
    expect(() => {
      first.tasks[0].title = "Mutated result";
    }).toThrow();
    expect((await f.call({ action: "list" })).details).toEqual(first);
    const root = f.session.sessionManager.getLeafId();
    await f.call({ action: "clear", baseRevision: 1 });
    if (!root) throw new Error("missing root");
    await f.session.navigateTree(root);
    expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 1, tasks: [{ title: "A" }] });
    const append = vi.spyOn(f.session.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
      throw new Error("append denied");
    });
    await expect(f.call({ action: "clear", baseRevision: 1 })).rejects.toThrow("append denied");
    expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 1 });
    append.mockRestore();
    expect(f.errors).toEqual([]);
  });
  it("captures ownership before later awaited tool_call handlers can move the native branch", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture({
      after: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "todo" && event.input.action === "clear") {
            entered();
            await gate;
          }
        });
      },
    });
    try {
      await f.call({ action: "add", baseRevision: 0, title: "Branch A" });
      const pending = f.call({ action: "clear", baseRevision: 1 });
      await ready;
      f.session.sessionManager.resetLeaf(); // Native transition before our reconciliation handler.
      release();
      await expect(pending).rejects.toThrow("ownership");
      expect(f.session.sessionManager.getBranch()).toEqual([]);
    } finally {
      release();
    }
  });
  it("the native loader rejects static collisions in either order without shadowing the first owner", async () => {
    const other = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "todo",
        label: "other",
        description: "other tool",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [], details: "other" };
        },
      });
    };
    for (const order of ["before", "after"] as const) {
      const f = await fixture({ [order]: other, expectedLoadCollision: true });
      if (order === "before") {
        expect(f.session.getAllTools().find((tool) => tool.name === "todo")?.description).toBe("other tool");
        await expect(f.call({ action: "list" })).rejects.toThrow("disabled");
      } else {
        expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 0, tasks: [] });
      }
      expect(f.session.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === STATE_TYPE)).toBe(
        false,
      );
    }
  });
  it("does not bypass a host policy that deactivates or blocks model mutation tools", async () => {
    const f = await fixture();
    f.api.setActiveTools([]);
    await f.session.prompt("/todo");
    expect(f.session.getActiveToolNames()).toEqual([]);
    f.api.on("tool_call", (event) => (event.toolName === "todo" ? { block: true, reason: "Plan policy" } : undefined));
    await expect(f.call({ action: "add", baseRevision: 0, title: "Unauthorized" })).rejects.toThrow("Plan policy");
    expect(f.session.sessionManager.getBranch().some((e) => e.type === "custom" && e.customType === STATE_TYPE)).toBe(
      false,
    );
  });
  it("late registration never expands a restricted initial loadout; human commands remain usable when the tool is excluded", async () => {
    const terminal = terminalFixture();
    cleanup.push(() => terminal.dispose());
    const f = await fixture({
      terminal,
      tools: null,
      before: (pi) => {
        pi.on("session_start", () => {
          pi.setActiveTools([]);
        });
      },
    });
    expect(f.session.getActiveToolNames()).toEqual([]);
    const view = f.session.prompt("/todo");
    await vi.waitFor(() => expect(terminal.active()).toBeDefined());
    terminal.key("\x1b");
    await view;
    expect(f.session.getActiveToolNames()).toEqual([]);
    const excluded = await fixture({ tools: [] });
    await excluded.session.prompt("/todo");
    expect(excluded.errors).toEqual([]);
    expect(excluded.session.getActiveToolNames()).toEqual([]);
  });
  for (const fileBacked of [false, true])
    it(`native fork/new-session (${fileBacked ? "file" : "memory"}) recover selected path and invalidate old runtime`, async () => {
      const f = await fixture({ fileBacked });
      f.faux.setResponses([fauxAssistantMessage("First.")]);
      await f.session.prompt("First user turn.");
      const original = await f.call({ action: "add", baseRevision: 0, title: "Selected path task" });
      f.faux.setResponses([fauxAssistantMessage("Second.")]);
      await f.session.prompt("Second user turn.");
      const target = f.session.getUserMessagesForForking()[1]?.entryId;
      if (!target) throw new Error("missing fork target");
      await f.call({ action: "clear", baseRevision: 1 });
      const oldApi = f.api;
      expect(await f.host.fork(target)).toMatchObject({ cancelled: false });
      expect(() => oldApi.appendEntry(STATE_TYPE, { schemaVersion: 1, revision: 0, tasks: [] })).toThrow("stale");
      expect((await f.call({ action: "list" })).details).toEqual(original.details);
      expect(await f.host.newSession()).toMatchObject({ cancelled: false });
      expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 0, tasks: [] });
      expect(f.errors).toEqual([]);
    });
  it("cancelled native fork leaves the old checklist recoverable", async () => {
    const f = await fixture({
      after: (pi) => {
        pi.on("session_before_fork", () => ({ cancel: true }));
      },
    });
    f.faux.setResponses([fauxAssistantMessage("Start.")]);
    await f.session.prompt("Native user turn.");
    await f.call({ action: "add", baseRevision: 0, title: "Keep on cancel" });
    const target = f.session.getUserMessagesForForking()[0]?.entryId;
    if (!target) throw new Error("missing fork target");
    expect(await f.host.fork(target)).toEqual({ cancelled: true });
    expect((await f.call({ action: "list" })).details).toMatchObject({
      revision: 1,
      tasks: [{ title: "Keep on cancel" }],
    });
  });
});

for (const fullscreen of [true, false])
  describe(`actual ${fullscreen ? "fullscreen" : "regular"} terminal renderer`, () => {
    it("covers host chrome at 100%, navigates by ID, inspects deps, cancels safely, resizes CJK/ANSI text and confirms with distinct keys", async () => {
      const terminal = terminalFixture(fullscreen);
      cleanup.push(() => terminal.dispose());
      const f = await fixture({ terminal });
      await f.call({ action: "add", baseRevision: 0, title: "中文 task", description: "Details", status: "completed" });
      const first = (await f.call({ action: "list" })).details as Snapshot;
      await f.call({
        action: "add",
        baseRevision: 1,
        title: "\x1b[31m第二 task\x1b[0m",
        dependencies: [first.tasks[0].id],
      });
      const view = f.session.prompt("/todo");
      await vi.waitFor(() => expect(terminal.active()).toBeDefined());
      expect(terminal.lines().join("\n")).toContain("Session Todo");
      expect(terminal.lines().join("\n")).not.toContain("Native footer");
      expect(terminal.bounds()).toMatchObject({ width: 80, height: 24 });
      terminal.key("\x1b[F");
      terminal.key("\r");
      expect(terminal.lines().join("\n")).toContain(first.tasks[0].id);
      terminal.key("\x1b");
      for (const [width, height] of [
        [40, 12],
        [1, 12],
        [100, 30],
      ]) {
        terminal.resize(width, height);
        expect(terminal.lines().length).toBeLessThanOrEqual(height);
        expect(terminal.lines().every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(terminal.bounds()).toMatchObject({ width, height });
      }
      terminal.key("d");
      terminal.key("d");
      terminal.key("y");
      expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 2, tasks: [{}, {}] });
      terminal.key("d");
      terminal.key("y");
      await vi.waitFor(() => expect(terminal.active()).toBeDefined());
      await vi.waitFor(async () =>
        expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 3, tasks: [{}] }),
      );
      terminal.key("\x1b");
      await view;
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.draft);
      expect(f.errors).toEqual([]);
    });
    it("cancels add dialogs without mutation and retires awaiting callbacks when authoritative branch data changes", async () => {
      const terminal = terminalFixture(fullscreen);
      cleanup.push(() => terminal.dispose());
      const f = await fixture({ terminal });
      const rootCursor = terminal.draft.render(80);
      const view = f.session.prompt("/todo");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Session Todo"));
      terminal.key("a");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Task title"));
      expect(terminal.active()).toBeInstanceOf(OwnedOverlay);
      terminal.key("Cancelled draft");
      terminal.key("\x1b");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Session Todo"));
      expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 0, tasks: [] });
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.active());
      terminal.key("a");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Task title"));
      terminal.key("Stale dialog input");
      const oldComponent = terminal.active();
      expect(oldComponent).toBeInstanceOf(OwnedOverlay);
      await f.call({ action: "add", baseRevision: 0, title: "Concurrent user" });
      terminal.key(" after concurrent change");
      terminal.key("\x13"); // Guard rejects saving the typed form against the old revision.
      await view;
      oldComponent?.handleInput?.("Late disposed input");
      oldComponent?.handleInput?.("\x13");
      expect((await f.call({ action: "list" })).details).toMatchObject({
        revision: 1,
        tasks: [{ title: "Concurrent user" }],
      });
      expect(
        f.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === STATE_TYPE),
      ).toHaveLength(1);
      expect(terminal.active()).toBeUndefined();
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.draft);
      expect(terminal.draft.render(80)).toEqual(rootCursor);
      expect(terminal.ui.input).not.toHaveBeenCalled();
      expect(terminal.ui.select).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    });
    it("explicit human add/edit/status/reopen/clear controls work without model-tool activation", async () => {
      const terminal = terminalFixture(fullscreen);
      cleanup.push(() => terminal.dispose());
      const f = await fixture({ terminal, tools: [] });
      const rootCursor = terminal.draft.render(80);
      const view = f.session.prompt("/todo");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Session Todo"));
      terminal.key("a");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Task title"));
      expect(terminal.active()).toBeInstanceOf(OwnedOverlay);
      terminal.key("Human task");
      terminal.key("\r");
      expect(terminal.lines().join("\n")).toContain("Description (0-512");
      terminal.key("Human description");
      terminal.key("\r");
      expect(terminal.lines().join("\n")).toContain("Dependency UUIDs");
      terminal.key("\r");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Session Todo"));
      const added = (await f.call({ action: "list" })).details as Snapshot;
      expect(added).toMatchObject({
        revision: 1,
        tasks: [{ title: "Human task", description: "Human description", dependencies: [], status: "pending" }],
      });
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.active());
      terminal.key("e");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Task title"));
      expect(terminal.lines().join("\n")).toContain("Human task"); // Real prefilled Input, not a placeholder.
      terminal.key("\x1b[F");
      terminal.key("\x15");
      terminal.key("Edited human task");
      terminal.key("\r");
      expect(terminal.lines().join("\n")).toContain("Human description");
      terminal.key("\x1b[F");
      terminal.key("\x15"); // Explicitly clear the native Editor's existing description.
      terminal.key("\r");
      expect(terminal.lines().join("\n")).toContain("Dependency UUIDs");
      terminal.key("\x13");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Session Todo"));
      const edited = (await f.call({ action: "list" })).details as Snapshot;
      expect(edited).toMatchObject({
        revision: 2,
        tasks: [
          { id: added.tasks[0].id, title: "Edited human task", description: "", dependencies: [], status: "pending" },
        ],
      });
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.active());
      for (const [i, status] of ["in_progress", "completed", "pending"].entries()) {
        terminal.key("s");
        await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Task status"));
        expect(terminal.active()).toBeInstanceOf(OwnedOverlay);
        const current = ["pending", "in_progress", "completed"][i];
        expect(terminal.lines().join("\n")).toContain(`> ${current}`);
        if (status === "pending") {
          terminal.key("\x1b[A");
          terminal.key("\x1b[A");
        } else terminal.key("\x1b[B");
        terminal.key("\r");
        await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain(`[${status}]`));
        expect((await f.call({ action: "list" })).details).toEqual({
          ...edited,
          revision: i + 3,
          tasks: [{ ...edited.tasks[0], status }],
        });
        expect(terminal.draft.getValue()).toBe("Keep this root draft");
        expect(terminal.tui.getFocusedComponent()).toBe(terminal.active());
      }
      terminal.key("D");
      terminal.key("y");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Empty checklist"));
      expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 6, tasks: [] });
      terminal.key("\x1b");
      await view;
      expect(f.session.getActiveToolNames()).toEqual([]);
      const states = f.session.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === STATE_TYPE);
      expect(states).toHaveLength(6);
      expect(states.map((entry) => (entry.type === "custom" ? (entry.data as Snapshot).revision : undefined))).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(states.at(-1)).toMatchObject({ data: { revision: 6, tasks: [] } });
      expect(terminal.active()).toBeUndefined();
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.draft);
      expect(terminal.draft.render(80)).toEqual(rootCursor);
      expect(terminal.ui.input).not.toHaveBeenCalled();
      expect(terminal.ui.select).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    });
    it("reload aborts an owned input dialog and retires old callbacks without destination writes", async () => {
      const terminal = terminalFixture(fullscreen);
      cleanup.push(() => terminal.dispose());
      const f = await fixture({ terminal });
      const rootCursor = terminal.draft.render(80);
      const view = f.session.prompt("/todo");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Session Todo"));
      terminal.key("a");
      await vi.waitFor(() => expect(terminal.lines().join("\n")).toContain("Task title"));
      terminal.key("Stale input");
      expect(terminal.lines().join("\n")).toContain("Stale input");
      const oldComponent = terminal.active();
      expect(oldComponent).toBeInstanceOf(OwnedOverlay);
      await f.session.reload();
      await view;
      expect(terminal.active()).toBeUndefined();
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.draft);
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.draft.render(80)).toEqual(rootCursor);
      oldComponent?.handleInput?.("Late disposed input");
      oldComponent?.handleInput?.("\r");
      oldComponent?.handleInput?.("\r");
      oldComponent?.handleInput?.("\r");
      oldComponent?.handleInput?.("\x13");
      expect((await f.call({ action: "list" })).details).toMatchObject({ revision: 0, tasks: [] });
      expect(
        f.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === STATE_TYPE),
      ).toHaveLength(0);
      expect(terminal.active()).toBeUndefined();
      expect(terminal.tui.getFocusedComponent()).toBe(terminal.draft);
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
      expect(terminal.draft.render(80)).toEqual(rootCursor);
      expect(terminal.ui.input).not.toHaveBeenCalled();
      expect(terminal.ui.select).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    });
    it("reconciliation retires an open screen and preserves draft without launching a model turn", async () => {
      const terminal = terminalFixture(fullscreen);
      cleanup.push(() => terminal.dispose());
      const f = await fixture({ terminal });
      const first = await f.call({ action: "add", baseRevision: 0, title: "A" });
      const target = f.session.sessionManager.getLeafId();
      await f.call({ action: "clear", baseRevision: 1 });
      const probe = vi.fn(() => fauxAssistantMessage("Unexpected."));
      f.faux.setResponses([probe]);
      const view = f.session.prompt("/todo");
      await vi.waitFor(() => expect(terminal.active()).toBeDefined());
      if (!target) throw new Error("missing target");
      await f.session.navigateTree(target);
      await view;
      expect(terminal.active()).toBeUndefined();
      expect((await f.call({ action: "list" })).details).toEqual(first.details);
      expect(probe).not.toHaveBeenCalled();
      expect(terminal.draft.getValue()).toBe("Keep this root draft");
    });
  });
