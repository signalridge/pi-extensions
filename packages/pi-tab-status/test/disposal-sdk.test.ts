import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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
import tabStatus from "../tab-status.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const scenario of ["headless run", "TUI run", "settlement"] as const) {
  test(`installed SDK dispose during ${scenario} leaves no throwing or recurring title timers`, async () => {
    assert.equal(VERSION, "1.4.0");
    const cwd = mkdtempSync(join(tmpdir(), "tab-dispose-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let captured: ExtensionContext | undefined;
    let release: (() => void) | undefined;
    let pending: Promise<unknown> | undefined;
    let compaction: Promise<unknown> | undefined;
    let shutdowns = 0;
    const errors: unknown[] = [];
    const titles: string[] = [];
    // Capture just the extension deadlines; leave the installed host's timers real.
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
    const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      if (delay !== 180_000 && delay !== 25) return nativeSetTimeout(callback, delay);
      const timer = nativeSetTimeout(() => {}, 3_600_000);
      timers.set(timer, { callback, delay });
      return timer;
    }) as typeof setTimeout);
    const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer);
      nativeClearTimeout(timer);
    }) as typeof clearTimeout);
    try {
      const faux = fauxProvider({ provider: "tab-disposal", models: [{ id: "test", contextWindow: 200_000 }] });
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
            // A previous settled observer starts compaction before tab status sees idle.
            if (scenario === "settlement") {
              pi.on("agent_settled", async () => {
                compaction = session?.compact();
                void compaction?.catch(() => undefined);
                for (let index = 0; index < 100 && !release; index++) await flush();
                assert.ok(release, "manual compaction has entered its provider request");
              });
            }
            tabStatus(pi);
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
        model: registry.find("tab-disposal", "test"),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1 },
          retry: { enabled: false },
        }),
      }));
      await session.bindExtensions({
        mode: scenario === "headless run" ? "print" : "tui",
        uiContext: { setTitle: (title: string) => titles.push(title) } as never,
        onError: (error) => errors.push(error),
      });
      const blocked = async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return fauxAssistantMessage("Finished.");
      };
      faux.setResponses(
        scenario === "settlement" ? [fauxAssistantMessage("Completed work. ".repeat(500)), blocked] : [blocked],
      );
      pending = session.prompt("Inspect the failure and explain the completed change.");
      // Only drain real host tasks: never poll with the intercepted deadlines.
      for (let index = 0; index < 100 && !release; index++) await flush();
      assert.ok(release, "a real provider request is pending at disposal");
      if (scenario === "settlement") await pending;
      assert.equal(session.isIdle, false);
      const owned = [...timers.entries()];
      if (scenario === "headless run") {
        assert.equal(owned.length, 0, "headless activity must not arm a 180-second title deadline");
        assert.deepEqual(titles, []);
      } else {
        assert.equal(owned.length, scenario === "settlement" ? 2 : 1);
        assert.ok(owned.some(([, timer]) => timer.delay === (scenario === "settlement" ? 25 : 180_000)));
        for (const [timer] of owned)
          assert.equal(timer.hasRef(), false, "ambient timers must not keep the process alive");
      }
      const before = titles.length;
      session.dispose();
      assert.equal(shutdowns, 0);
      assert.throws(() => captured?.isIdle(), /stale/);
      // Fire the settlement deadline first so retirement also cancels inactivity.
      owned.sort((a, b) => a[1].delay - b[1].delay);
      for (const [timer, { callback }] of owned) {
        timers.delete(timer);
        nativeClearTimeout(timer);
        assert.doesNotThrow(callback);
      }
      assert.equal(timers.size, 0, "invalidated callbacks must not repeat");
      // Even a callback already queued before retirement cannot rearm.
      for (const [, { callback }] of owned) assert.doesNotThrow(callback);
      assert.equal(timers.size, 0);
      assert.equal(titles.length, before);
      release();
      await pending.catch(() => undefined);
      await compaction?.catch(() => undefined);
      assert.deepEqual(errors, []);
    } finally {
      release?.();
      session?.dispose();
      await pending?.catch(() => undefined);
      await compaction?.catch(() => undefined);
      for (const timer of timers.keys()) nativeClearTimeout(timer);
      schedule.mockRestore();
      cancel.mockRestore();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
