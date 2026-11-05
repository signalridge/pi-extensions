import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import statusline from "../src/statusline.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
type Footer = { render(width: number): string[]; dispose(): void };

for (const boundary of [
  "usage",
  "clock",
  "branch",
  "result",
  "replacement",
  "print",
  "rpc",
  "print-clock-barrier",
  "rpc-branch-barrier",
  "print-result-barrier",
] as const) {
  test(`actual SDK disposal retires statusline ${boundary}, even when unsubscribe throws`, async () => {
    assert.ok(["1.0.4", "1.5.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
    const cwd = mkdtempSync(join(tmpdir(), "statusline-dispose-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "pi-statusline.json"), JSON.stringify({ segments: ["tokens"] }));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let captured: ExtensionContext | undefined;
    let footer: Footer | undefined;
    let branch = () => {};
    let unsubscribes = 0;
    let renders = 0;
    let uiWrites = 0;
    let shutdowns = 0;
    let requests = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blockStart = false;
    let enteredStart = false;
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let rebinding: Promise<void> | undefined;
    const errors: unknown[] = [];
    const signals: AbortSignal[] = [];
    try {
      if (boundary.endsWith("-barrier")) {
        execFileSync("git", ["init", "-q"], { cwd });
        writeFileSync(join(cwd, "tracked.txt"), "fixture\n");
        execFileSync("git", ["add", "--", "tracked.txt"], { cwd });
      }
      const faux = fauxProvider({ provider: "statusline-disposal", models: [{ id: "test" }] });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          (pi) => {
            pi.on("session_start", async () => {
              if (!blockStart) return;
              enteredStart = true;
              await startGate;
            });
            pi.exec = async (command, args, options) => {
              requests++;
              if (options?.signal) signals.push(options.signal);
              const result = boundary.endsWith("-barrier")
                ? {
                    stdout: execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" }),
                    stderr: "",
                    code: 0,
                    killed: false,
                  }
                : { stdout: "", stderr: "", code: 1, killed: false };
              if (boundary === "result" || boundary === "print-result-barrier") await gate;
              return result;
            };
            statusline(pi);
            pi.on("session_start", (_event, ctx) => {
              captured = ctx;
            });
            pi.on("session_shutdown", () => {
              shutdowns++;
            });
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const registry = new ModelRegistry(runtime);
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        modelRegistry: registry,
        model: registry.find("statusline-disposal", "test"),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      await session.bindExtensions({
        mode: "tui",
        uiContext: {
          notify: () => {
            uiWrites++;
          },
          setStatus: () => {
            uiWrites++;
          },
          setFooter: (factory: (...args: unknown[]) => Footer) => {
            uiWrites++;
            footer = factory(
              {
                requestRender: () => {
                  renders++;
                },
              },
              { fg: (_color: string, text: string) => text, bold: (text: string) => text },
              {
                getGitBranch: () => null,
                getExtensionStatuses: () => new Map(),
                onBranchChange: (callback: () => void) => {
                  branch = callback;
                  return () => {
                    unsubscribes++;
                    throw new Error("unsubscribe fault");
                  };
                },
              },
            );
          },
        } as never,
        onError: (error) => errors.push(error),
      });
      await flush();
      assert.equal(requests, 2);
      assert.equal(vi.getTimerCount(), 2);
      if (boundary === "replacement") {
        const outgoing = footer;
        const outgoingBranch = branch;
        await session.bindExtensions({ mode: "tui" });
        await flush();
        assert.equal(unsubscribes, 1);
        assert.equal(vi.getTimerCount(), 2, "only replacement clocks remain");
        const replacement = { renders, uiWrites, requests };
        outgoing?.dispose();
        outgoingBranch();
        assert.deepEqual(outgoing?.render(80), []);
        assert.deepEqual(
          { renders, uiWrites, requests },
          replacement,
          "outgoing callbacks cannot clear or refresh replacement",
        );
      }
      const before = { renders, uiWrites, requests };
      if (boundary.endsWith("-barrier")) {
        assert.ok(captured);
        const manager = captured.sessionManager;
        blockStart = true;
        writeFileSync(join(agentDir, "pi-statusline.json"), "{ malformed");
        const mode = boundary === "rpc-branch-barrier" ? "rpc" : "print";
        rebinding = session.bindExtensions({ mode });
        await flush();
        assert.equal(enteredStart, true);
        assert.equal(captured.mode, mode);
        assert.equal(captured.sessionManager, manager, "SDK identity remains live before our lifecycle handler");
        if (boundary === "rpc-branch-barrier") branch();
        else if (boundary === "print-result-barrier") {
          release();
          await flush();
        } else await vi.advanceTimersByTimeAsync(5_000);
        assert.equal(vi.getTimerCount(), 0, "both footer clocks retire before our lifecycle handler");
        assert.equal(unsubscribes, 1);
        assert.deepEqual(footer?.render(80), []);
        branch();
        await vi.advanceTimersByTimeAsync(120_000);
        assert.deepEqual({ renders, uiWrites, requests }, before, "no render, status, warning or Git work");
        if (boundary === "print-result-barrier") assert.ok(signals.every((signal) => signal.aborted));
        assert.deepEqual(errors, []);
        return;
      }
      if (boundary === "print" || boundary === "rpc") {
        writeFileSync(join(agentDir, "pi-statusline.json"), "{ malformed");
        await session.bindExtensions({ mode: boundary });
        assert.equal(vi.getTimerCount(), 0);
        branch();
        assert.deepEqual(footer?.render(80), []);
        await vi.advanceTimersByTimeAsync(120_000);
        assert.deepEqual(
          { renders, uiWrites, requests },
          before,
          "malformed settings and retained UI are silent headlessly",
        );
        assert.equal(unsubscribes, 1);
        assert.deepEqual(errors, []);
        return;
      }
      session.dispose();
      assert.equal(shutdowns, 0);
      assert.throws(() => captured?.sessionManager, /stale/);
      if (boundary === "branch") branch();
      if (boundary === "usage" || boundary === "replacement") await vi.advanceTimersByTimeAsync(5_000);
      if (boundary === "clock") await vi.advanceTimersByTimeAsync(30_000);
      if (boundary === "result") {
        release();
        await flush();
      }
      assert.equal(vi.getTimerCount(), 0);
      assert.equal(unsubscribes, boundary === "replacement" ? 2 : 1);
      assert.deepEqual(footer?.render(80), []);
      footer?.dispose();
      branch();
      await vi.advanceTimersByTimeAsync(120_000);
      assert.deepEqual({ renders, uiWrites, requests }, before);
      assert.ok(signals.every((signal) => signal.aborted === (boundary === "result")));
      assert.deepEqual(errors, []);
    } finally {
      releaseStart();
      await rebinding;
      release();
      footer?.dispose();
      session?.dispose();
      vi.useRealTimers();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
