import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_QUERY_CHANNEL,
  type ApprovalOperation,
  type ApprovalRequestOptions,
  type ApprovalService,
  queryApprovalAdapter,
  validateQuery,
} from "@signalridge/pi-approval-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobManager } from "../src/contracts.js";
import background from "../src/extension.js";

const managers = vi.hoisted(() => [] as JobManager[]);
vi.mock("../src/manager.js", async (original) => {
  const module = await original<typeof import("../src/manager.js")>();
  return {
    ...module,
    createJobManager: (emit: Parameters<typeof module.createJobManager>[0]) => {
      const manager = module.createJobManager(emit);
      vi.spyOn(manager, "start");
      vi.spyOn(manager, "watch");
      managers.push(manager);
      return manager;
    },
  };
});

/** Human-owned root peer fixture: public bus + public command/UI, never a model tool. */
function rootPeer(ttl = 10_000) {
  let current: ApprovalService | undefined;
  let context: ExtensionContext | undefined;
  let pending:
    | {
        operation: ApprovalOperation;
        options: ApprovalRequestOptions;
        settle(error?: Error): void;
      }
    | undefined;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const factory = (pi: ExtensionAPI) => {
    const service: ApprovalService = Object.freeze({
      version: 1,
      id: "root-human-peer",
      request: (operation: ApprovalOperation, options: ApprovalRequestOptions) => {
        if (!context?.hasUI || !options.isCurrent() || options.signal?.aborted)
          return Promise.reject(new Error("No current human approval UI"));
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => settle(new Error("Approval expired")), ttl);
          const abort = () => settle(new Error("Approval aborted"));
          const settle = (error?: Error) => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            pending = undefined;
            if (error) reject(error);
            else resolve();
          };
          pending = { operation, options, settle };
          options.signal?.addEventListener("abort", abort, { once: true });
          entered();
        });
      },
    });
    const unsubscribe = pi.events.on(APPROVAL_QUERY_CHANNEL, (value) => {
      if (current) validateQuery(value).respond(current);
    });
    pi.on("session_start", (_event, ctx) => {
      context = ctx;
      current = service;
    });
    pi.on("session_shutdown", () => {
      pending?.settle(new Error("Root retired"));
      current = undefined;
      context = undefined;
      unsubscribe();
    });
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash_background" && event.toolName !== "monitor") return;
      const effective = pi.getAllTools().find((tool) => tool.name === event.toolName);
      if (!effective) throw new Error("Missing background tool");
      queryApprovalAdapter(pi.events, event.toolName, effective.parameters);
    });
    pi.registerCommand("review-background", {
      description: "Human-only test approval review",
      handler: async (args, ctx) => {
        const item = pending;
        if (!item) throw new Error("No pending approval");
        if (args === "deny") {
          item.settle(new Error("Human declined"));
          return;
        }
        const approved = await ctx.ui.confirm("Approve background command?", item.operation.preview);
        try {
          if (!approved || item.options.signal?.aborted || !item.options.isCurrent())
            throw new Error("Human approval denied or stale");
          item.settle();
        } catch (error) {
          item.settle(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  };
  return {
    factory,
    waiting,
    operation: () => pending?.operation,
    replace: () => {
      current = { version: 1, id: "replacement-root", request: async () => {} };
    },
  };
}

describe.skipIf(!["1.0.4", "1.1.0"].includes(VERSION) || process.platform === "win32")(
  "background approvals on the real SDK",
  () => {
    const cleanup: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const dispose of cleanup.splice(0).reverse()) await dispose();
      managers.length = 0;
    });

    async function fixture(
      options: { peer?: ReturnType<typeof rootPeer>; hook?: (pi: ExtensionAPI) => void; headless?: boolean } = {},
    ) {
      const cwd = mkdtempSync(join(tmpdir(), "background-approval-host-"));
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir);
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      cleanup.push(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(cwd, { recursive: true, force: true });
      });
      const faux = fauxProvider({ provider: "background-approval-faux", models: [{ id: "background" }] });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const model = new ModelRegistry(runtime).find("background-approval-faux", "background");
      if (!model) throw new Error("Missing faux model");
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          ...(options.peer ? [{ name: "root-human", factory: options.peer.factory }] : []),
          { name: "background", factory: background },
          ...(options.hook ? [{ name: "last-hook", factory: options.hook }] : []),
        ],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const sessionManager = SessionManager.inMemory(cwd);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager,
        tools: ["bash_background", "monitor", "background_list"],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      const confirm = vi.fn(async () => true);
      const ui = { confirm, setStatus: vi.fn(), notify: vi.fn() } as unknown as ExtensionUIContext;
      const errors: string[] = [];
      cleanup.push(async () => {
        await session.abort();
        await session.reload();
        session.dispose();
        faux.setResponses([]);
      });
      await session.bindExtensions({
        onError: (error) => errors.push(String(error)),
        ...(options.headless ? {} : { mode: "tui" as const, uiContext: ui }),
      });
      const manager = managers.at(-1);
      if (!manager) throw new Error("Background manager missing");
      const marker = join(cwd, "launched");
      const command = `printf approved > '${marker}'`;
      const launch = (
        name = "bash_background",
        args: Parameters<typeof fauxToolCall>[1] = { command, notify: "context" },
      ) => {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
          fauxAssistantMessage("Independent work."),
        ]);
        return session.prompt("Start useful independent work.");
      };
      const assertUnlaunched = () => {
        expect(manager.start).not.toHaveBeenCalled();
        expect(manager.watch).not.toHaveBeenCalled();
        expect(manager.list()).toEqual([]);
        expect(existsSync(marker)).toBe(false);
      };
      return { session, sessionManager, manager, launch, marker, command, confirm, errors, assertUnlaunched };
    }

    it("does not allocate a job/process before human approval, then launches exact final hook inputs", async () => {
      const root = rootPeer();
      const f = await fixture({
        peer: root,
        hook: (pi) =>
          pi.on("tool_call", (event) => {
            if (event.toolName === "bash_background") {
              event.input.command = `${event.input.command}; printf final-hook`;
              event.input.description = "Final hook description";
            }
          }),
      });
      const running = f.launch();
      await root.waiting;
      f.assertUnlaunched();
      const approvedCommand = `${f.command}; printf final-hook`;
      expect(root.operation()).toMatchObject({
        command: approvedCommand,
        source: "background",
        toolName: "bash_background",
      });
      expect(root.operation()?.preview).toContain("Final hook description");
      await f.session.prompt("/review-background");
      await running;
      expect(f.confirm).toHaveBeenCalledOnce();
      expect(f.manager.start).toHaveBeenCalledOnce();
      expect(vi.mocked(f.manager.start).mock.calls[0][0].command).toBe(approvedCommand);
      await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
      expect(readFileSync(f.marker, "utf8")).toBe("approved");
      const job = f.manager.list()[0];
      await f.manager.shutdown();
      const pid = job.pid;
      if (!pid) throw new Error("Expected process group leader");
      expect(() => process.kill(-pid, 0)).toThrow();
      expect(f.errors).toEqual([]);
    });

    it.each(["decline", "timeout", "abort", "owner", "replacement"])(
      "never starts a real process on %s",
      async (reason) => {
        const root = rootPeer(reason === "timeout" ? 40 : 10_000);
        const f = await fixture({ peer: root });
        const running = f.launch("monitor", { command: f.command, patterns: ["approved"], notify: "context" });
        await root.waiting;
        f.assertUnlaunched();
        if (reason === "decline") await f.session.prompt("/review-background deny");
        if (reason === "abort") await f.session.abort();
        if (reason === "owner") {
          f.sessionManager.resetLeaf();
          await f.session.prompt("/review-background");
        }
        if (reason === "replacement") {
          root.replace();
          await f.session.prompt("/review-background");
        }
        await running;
        f.assertUnlaunched();
      },
    );

    it("a loaded headless peer denies rather than falling back", async () => {
      const f = await fixture({ peer: rootPeer(), headless: true });
      await f.launch();
      f.assertUnlaunched();
    });

    it("revalidates invalid late hook mutations before discovery/human review", async () => {
      const root = rootPeer();
      const f = await fixture({
        peer: root,
        hook: (pi) =>
          pi.on("tool_call", (event) => {
            if (event.toolName === "bash_background") event.input.timeout_ms = 1.5;
          }),
      });
      await f.launch();
      expect(root.operation()).toBeUndefined();
      expect(f.confirm).not.toHaveBeenCalled();
      f.assertUnlaunched();
    });

    it("no peer preserves ordinary launch behavior without human UI", async () => {
      const f = await fixture({ headless: true });
      await f.launch();
      expect(f.manager.start).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    });
  },
);
