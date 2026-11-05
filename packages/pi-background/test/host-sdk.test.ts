import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import background from "../src/extension.js";
import { MESSAGE_TYPE, Notifications } from "../src/notifications.js";
import { nativeUIFixture } from "./tui-fixture.js";

// Real host loader, lifecycle, provider dispatch and tool pipeline. No paid model.
describe.skipIf(!["1.5.0"].includes(VERSION) || process.platform === "win32")(
  "background on supported installed Pi",
  () => {
    const cleanup: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const dispose of cleanup.splice(0).reverse()) await dispose();
    });

    async function fixture(
      inputGate?: (pi: ExtensionAPI) => void,
      laterGate?: (pi: ExtensionAPI) => void,
      native?: ReturnType<typeof nativeUIFixture>,
    ) {
      const cwd = mkdtempSync(join(tmpdir(), "background-host-"));
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir);
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      cleanup.push(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(cwd, { recursive: true, force: true });
      });
      const faux = fauxProvider({ provider: "background-faux", models: [{ id: "background" }] });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const registry = new ModelRegistry(runtime);
      const model = registry.find("background-faux", "background");
      if (!model) throw new Error("missing faux model");
      const errors: string[] = [];
      const prompts: string[] = [];
      const inputs: string[] = [];
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          ...(inputGate ? [{ name: "input-gate", factory: inputGate }] : []),
          { name: "background", factory: background },
          ...(laterGate ? [{ name: "later-gate", factory: laterGate }] : []),
          {
            name: "probes",
            factory: (pi) => {
              pi.on("before_agent_start", (event) => {
                // Pi 1.2+ also prepares idle custom-message runs; record every run
                // so a custom-message wake cannot slip past the run assertions.
                prompts.push(event.messageType === "custom" ? `custom:${event.message.customType}` : event.prompt);
              });
              pi.on("input", (event) => {
                inputs.push(event.source);
              });
            },
          },
        ],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["bash_background", "background_list"],
        settingsManager,
      });
      cleanup.push(async () => {
        await session.abort();
        await session.reload(); // Public reload tears down any remaining jobs.
        session.dispose();
        faux.setResponses([]);
      });
      await session.bindExtensions({
        onError: (error) => errors.push(String(error)),
        ...(native ? { mode: "tui" as const, uiContext: native.ui } : {}),
      });
      const host = new AgentSessionRuntime(
        session,
        { cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, diagnostics: [] },
        async () => {
          throw new Error("Cancelled fork must not replace the runtime");
        },
      );
      return { session, host, faux, errors, prompts, inputs };
    }

    it("opens native task/log screens only on commands and confirms an owned stop through public UI bindings", async () => {
      const native = nativeUIFixture();
      cleanup.push(async () => native.dispose());
      const { session, faux, errors } = await fixture(undefined, undefined, native);
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash_background", {
            command: "printf 'stdout-marker\\n'; printf 'stderr-marker\\n' >&2; sleep 20",
            notify: "off",
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Independent work remains."),
      ]);
      await session.prompt("Start useful independent work.");
      expect(native.custom).not.toHaveBeenCalled();
      const command = session.prompt("/background");
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      expect(native.render().join("\n")).toContain("Background tasks");
      native.key("\r"); // Job overview.
      native.key("\r"); // Actual logs, not the command's quoted marker in metadata.
      native.key("s");
      native.key("s");
      await vi.waitFor(() =>
        expect(native.render().some((line) => stripVTControlCharacters(line).trim() === "stderr-marker")).toBe(true),
      );
      native.key("x");
      native.key("x");
      native.key("y");
      expect(native.render().join("\n")).toContain("Background logs · running");
      native.key("x");
      native.key("y");
      await vi.waitFor(() => expect(native.render().join("\n")).toContain("Background logs · stopped"));
      native.key("\x1b");
      native.key("\x1b");
      native.key("\x1b");
      await command;
      expect(native.component()).toBeUndefined();
      expect(session.messages.some((message) => message.role === "custom" && message.customType === MESSAGE_TYPE)).toBe(
        false,
      );
      expect(errors).toEqual([]);
    });

    it("refreshes passive status for real notify-off completion without any later model or tool turn", async () => {
      const native = nativeUIFixture();
      cleanup.push(async () => native.dispose());
      const { session, faux, errors, prompts, inputs } = await fixture(undefined, undefined, native);
      const unexpected = vi.fn(() => fauxAssistantMessage("Unexpected wake."));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash_background", {
            command: "sleep 0.2; printf complete",
            notify: "off",
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Independent work can continue."),
        unexpected,
      ]);
      await session.prompt("Start silent independent work.");
      await vi.waitFor(
        () => expect(native.ui.setStatus).toHaveBeenLastCalledWith("pi-background", "Ctrl+Alt+B tasks · R0 F1"),
        { timeout: 5000 },
      );
      expect(prompts).toEqual(["Start silent independent work."]);
      expect(inputs).toEqual(["interactive"]);
      expect(unexpected).not.toHaveBeenCalled();
      expect(session.messages.some((message) => message.role === "custom" && message.customType === MESSAGE_TYPE)).toBe(
        false,
      );
      expect(native.custom).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });

    it("wakes once at idle exit, delivers the matching custom message and has a valid structured tool result", async () => {
      const { session, faux, errors, prompts, inputs } = await fixture();
      const wake = vi.fn((_context: TranscriptContext) => fauxAssistantMessage("Exit received."));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash_background", { command: "sleep 0.1; printf complete", notify: "turn" }),
          {
            stopReason: "toolUse",
          },
        ),
        fauxAssistantMessage("Job started."),
        wake,
      ]);
      await session.prompt("Run in background.");
      await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce(), { timeout: 5000 });
      await vi.waitFor(() => expect(session.isStreaming).toBe(false), { timeout: 5000 });
      const notification = session.messages.find(
        (message) => message.role === "custom" && message.customType === MESSAGE_TYPE,
      );
      expect(notification).toMatchObject({ role: "custom", customType: MESSAGE_TYPE });
      expect(JSON.stringify(wake.mock.calls[0][0].messages)).toContain("[exit:");
      expect(prompts).toHaveLength(2); // The wake is a public prompt run, not a custom-message run.
      expect(prompts[1]).toContain("Background process wake [");
      expect(inputs).toEqual(["interactive", "extension"]);
      const result = session.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "bash_background",
      );
      expect(result).toMatchObject({ role: "toolResult", isError: false });
      // An additional user turn must not replay the already acknowledged wake.
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("background_list", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Listed."),
      ]);
      await session.prompt("Inspect jobs.");
      const list = [...session.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === "background_list");
      expect(list).toMatchObject({ isError: false, details: { pendingNotifications: 0, deliveryPaused: false } });
      expect(errors).toEqual([]);
    });

    it("consumes old input after the new leaf commits but before an earlier tree handler returns", async () => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let releaseTree!: () => void;
      let enteredTree!: () => void;
      const treeGate = new Promise<void>((resolve) => {
        releaseTree = resolve;
      });
      const treeBlocked = new Promise<void>((resolve) => {
        enteredTree = resolve;
      });
      const { session, faux, errors, prompts } = await fixture((pi) => {
        pi.on("input", async (event) => {
          if (event.source !== "extension") return;
          entered();
          await gate;
        });
        pi.on("session_tree", async () => {
          enteredTree();
          await treeGate;
        });
      });
      const ack = vi.spyOn(Notifications.prototype, "acknowledge");
      cleanup.push(async () => {
        ack.mockRestore();
      });
      const staleWake = vi.fn(() => fauxAssistantMessage("Stale wake."));
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash_background", { command: "printf complete", notify: "turn" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Started."),
        staleWake,
      ]);
      try {
        await session.prompt("Start a job.");
        await blocked;
        const target = session.getUserMessagesForForking()[0]?.entryId;
        if (!target) throw new Error("missing tree target");
        const oldLeaf = session.sessionManager.getLeafId();
        const navigation = session.navigateTree(target);
        await treeBlocked;
        expect(session.sessionManager.getLeafId()).not.toBe(oldLeaf);
        expect(session.sessionManager.getLeafId()).toBe(session.sessionManager.getEntry(target)?.parentId);
        // Deliberately release input first: background's tree handler has NOT run.
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(staleWake).not.toHaveBeenCalled();
        expect(prompts).toHaveLength(1);
        expect(ack).not.toHaveBeenCalled();
        const runner = session.extensionRunner;
        const tool = runner.getToolDefinition("background_list");
        if (!tool) throw new Error("missing background tool");
        await expect(
          tool.execute("old-access", {}, undefined, undefined, runner.createToolContext("old-access", undefined)),
        ).rejects.toThrow("No active background manager");
        releaseTree();
        await navigation;
        faux.setResponses([fauxAssistantMessage("New branch.")]);
        await session.prompt("Continue on the new branch.");
        expect(prompts).toEqual(["Start a job.", "Continue on the new branch."]);
        expect(errors).toEqual([]);
      } finally {
        release();
        releaseTree();
      }
    });

    it("keeps jobs and the outbox through an awaited cancelled fork, then explicitly retries once", async () => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { session, host, faux, errors } = await fixture(undefined, (pi) => {
        pi.on("session_before_fork", async () => {
          entered();
          await gate;
          return { cancel: true };
        });
      });
      const wake = vi.fn(() => fauxAssistantMessage("Recovered once."));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash_background", { command: "sleep .1; printf completed", notify: "turn" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Started."),
        wake,
      ]);
      const flush = vi.spyOn(Notifications.prototype, "flush");
      cleanup.push(async () => {
        flush.mockRestore();
      });
      try {
        await session.prompt("Start before forking.");
        const target = session.getUserMessagesForForking()[0]?.entryId;
        if (!target) throw new Error("missing fork target");
        const oldLeaf = session.sessionManager.getLeafId();
        const fork = host.fork(target);
        await blocked;
        await vi.waitFor(() => expect(flush).toHaveBeenCalled(), { timeout: 5000 });
        expect(wake).not.toHaveBeenCalled();
        expect(
          session.messages.some((message) => message.role === "custom" && message.customType === MESSAGE_TYPE),
        ).toBe(false);
        release();
        expect(await fork).toEqual({ cancelled: true });
        expect(session.sessionManager.getLeafId()).toBe(oldLeaf);
        const runner = session.extensionRunner;
        const tool = runner.getToolDefinition("background_list");
        if (!tool) throw new Error("missing background tool");
        const before = await tool.execute(
          "inspect",
          {},
          undefined,
          undefined,
          runner.createToolContext("inspect", undefined),
        );
        expect(before.details).toMatchObject({
          jobs: [expect.objectContaining({ status: "exited", exitCode: 0 })],
          pendingNotifications: 1,
        });
        await session.prompt("/background retry");
        await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce(), { timeout: 5000 });
        await vi.waitFor(() => expect(session.isStreaming).toBe(false));
        const after = await tool.execute(
          "inspect",
          {},
          undefined,
          undefined,
          runner.createToolContext("inspect", undefined),
        );
        expect(after.details).toMatchObject({
          jobs: [expect.objectContaining({ status: "exited", exitCode: 0 })],
          pendingNotifications: 0,
        });
        await session.prompt("/background retry");
        expect(wake).toHaveBeenCalledOnce();
        expect(errors).toEqual([]);
      } finally {
        release();
      }
    });

    it("records context-only exits without a model turn and discards jobs on session-tree navigation", async () => {
      const { session, faux, errors } = await fixture();
      const unexpected = vi.fn(() => fauxAssistantMessage("Unexpected wake."));
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash_background", { command: "sleep 0.1; printf complete", notify: "context" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Job started."),
        unexpected,
      ]);
      await session.prompt("Run without waking.");
      await vi.waitFor(
        () =>
          expect(
            session.messages.some((message) => message.role === "custom" && message.customType === MESSAGE_TYPE),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(unexpected).not.toHaveBeenCalled();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("background_list", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Inspected."),
      ]);
      await session.prompt("Inspect context-only delivery.");
      const beforeTree = [...session.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === "background_list");
      expect(beforeTree).toMatchObject({ isError: false, details: { pendingNotifications: 0, deliveryPaused: false } });
      const target = session.getUserMessagesForForking()[0]?.entryId;
      if (!target) throw new Error("missing tree target");
      await session.navigateTree(target);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("background_list", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Empty."),
      ]);
      await session.prompt("Inspect new session.");
      const list = [...session.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === "background_list");
      expect(list).toMatchObject({ isError: false, details: { jobs: [], pendingNotifications: 0 } });
      expect(errors).toEqual([]);
    });
  },
);
