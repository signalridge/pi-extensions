import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
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
import githubPr from "../src/github-pr.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn(fs.watch) };
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const deadline of ["poll", "expiry", "debounce", "in-flight", "print", "rpc"] as const) {
  test(`installed SDK retires GitHub ${deadline} ownership without shutdown`, async () => {
    assert.equal(VERSION, "1.5.0");
    const cwd = mkdtempSync(join(tmpdir(), "github-dispose-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(cwd, ".git"));
    const headPath = join(cwd, ".git", "HEAD");
    writeFileSync(headPath, "ref: refs/heads/main\n");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let captured: ExtensionContext | undefined;
    let shutdowns = 0;
    let requests = 0;
    let release: (() => void) | undefined;
    const signals: AbortSignal[] = [];
    const statuses: Array<string | undefined> = [];
    const errors: unknown[] = [];
    try {
      const faux = fauxProvider({ provider: "github-disposal", models: [{ id: "test" }] });
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
            // No real gh or Git processes: exercise the host context lifetime only.
            pi.exec = async (command, args, options) => {
              if (command === "git") return { stdout: ".git/HEAD", stderr: "", code: 0, killed: false };
              assert.ok(command === "gh" || command === "env", `unexpected executable: ${command}`);
              if (options?.signal) signals.push(options.signal);
              const isView = args.includes("view");
              if (isView) requests++;
              if (deadline === "in-flight" && isView && requests === 2) {
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              }
              const terminal = deadline === "expiry";
              const payload = isView
                ? {
                    number: 123,
                    url: "https://github.com/example/repo/pull/123",
                    state: terminal ? "MERGED" : "OPEN",
                    mergedAt: terminal ? new Date(Date.now() - 86_399_000).toISOString() : undefined,
                    statusCheckRollup: [],
                  }
                : {
                    data: { repository: { pullRequest: { comments: { totalCount: 0 }, reviews: { totalCount: 0 } } } },
                  };
              return { stdout: JSON.stringify(payload), stderr: "", code: 0, killed: false };
            };
            githubPr(pi, { refreshIntervalMs: 60_000 });
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
        model: registry.find("github-disposal", "test"),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await session.bindExtensions({
        mode: "tui",
        uiContext: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) } as never,
        onError: (error) => errors.push(error),
      });
      await flush();
      assert.equal(requests, 1);
      assert.ok(statuses.some((value) => value?.includes("#123")));
      assert.equal(vi.getTimerCount(), deadline === "expiry" ? 2 : 1);
      const watcher = vi.mocked(watch).mock.results.at(-1)?.value as ReturnType<typeof watch>;
      assert.ok(watcher);
      const close = vi.spyOn(watcher, "close");
      if (deadline === "debounce") {
        writeFileSync(headPath, "ref: refs/heads/next\n");
        // Drive a real watcher's notification deterministically (no service involved).
        watcher.emit("change", "change", "HEAD");
        assert.equal(vi.getTimerCount(), 1);
      }
      if (deadline === "in-flight") {
        await vi.advanceTimersByTimeAsync(60_000);
        assert.equal(requests, 2);
        assert.ok(release);
      }
      const before = statuses.length;
      if (deadline === "print" || deadline === "rpc") {
        const watches = vi.mocked(watch).mock.calls.length;
        await session.bindExtensions({ mode: deadline });
        await session.prompt("headless fixture");
        await flush();
        assert.equal(requests, 1, "headless start and agent_end do not query GitHub");
        assert.equal(vi.mocked(watch).mock.calls.length, watches, "no headless watcher");
        assert.equal(vi.getTimerCount(), 0, "outgoing TUI timers retire before headless activation");
        assert.equal(statuses.length, before, "no headless status writes or clears");
      }
      session.dispose();
      assert.equal(shutdowns, 0, "SDK dispose does not emit shutdown");
      assert.throws(() => captured?.sessionManager, /stale/);
      release?.();
      await flush();
      await vi.advanceTimersByTimeAsync(deadline === "debounce" ? 100 : deadline === "expiry" ? 1_100 : 60_000);
      assert.equal(close.mock.calls.length, 1, "invalid owner closes its watcher");
      assert.equal(vi.getTimerCount(), 0, "all owned timers retire");
      await vi.advanceTimersByTimeAsync(180_000);
      watcher.emit("change", "change", "HEAD");
      assert.equal(vi.getTimerCount(), 0, "old callbacks never rearm");
      assert.equal(requests, deadline === "in-flight" ? 2 : 1);
      assert.equal(statuses.length, before, "no retired-context UI writes");
      if (deadline === "in-flight") assert.equal(signals.at(-1)?.aborted, true);
      assert.deepEqual(errors, []);
    } finally {
      release?.();
      session?.dispose();
      vi.useRealTimers();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
