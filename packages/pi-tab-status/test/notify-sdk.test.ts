import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import tabStatus from "../tab-status.js";

const PINNED_ENV = [
  "PI_TAB_STATUS_NOTIFY",
  "PI_TAB_STATUS_STYLE",
  "TMUX",
  "KITTY_WINDOW_ID",
  "TERM_PROGRAM",
  "ITERM_SESSION_ID",
  "LC_TERMINAL",
  "PI_CODING_AGENT_DIR",
];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Scenario = {
  name: string;
  mode: "tui" | "print";
  abort: boolean;
  expected: (project: string) => string[];
};

const scenarios: Scenario[] = [
  {
    name: "a settled TUI run raises one desktop notification",
    mode: "tui",
    abort: false,
    expected: (project) => [`\x1b]777;notify;pi · ${project};Finished, ready for review\x07`],
  },
  {
    name: "an aborted TUI run settles silently",
    mode: "tui",
    abort: true,
    expected: () => [],
  },
  {
    name: "a non-TUI session, such as a subagent child, stays silent",
    mode: "print",
    abort: false,
    expected: () => [],
  },
];

for (const scenario of scenarios) {
  test(`installed SDK: ${scenario.name}`, async () => {
    assert.equal(VERSION, "1.4.0");
    const saved = new Map(PINNED_ENV.map((name) => [name, process.env[name]]));
    for (const name of PINNED_ENV) delete process.env[name];
    const cwd = mkdtempSync(join(tmpdir(), "tab-notify-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_TAB_STATUS_NOTIFY = "1";
    process.env.PI_TAB_STATUS_STYLE = "ridgeline";
    const writes: string[] = [];
    const nativeWrite = process.stdout.write.bind(process.stdout);
    const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
      const text = String(chunk);
      if (text.includes("\x1b")) {
        writes.push(text);
        return true;
      }
      return nativeWrite(chunk, ...rest);
    }) as typeof process.stdout.write);
    const settled: boolean[] = [];
    const titles: string[] = [];
    const errors: unknown[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const faux = fauxProvider({
        provider: "tab-notify",
        models: [{ id: "test", contextWindow: 200_000 }],
      });
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
            tabStatus(pi);
            pi.on("agent_settled", (event) => {
              settled.push(event.aborted);
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
        model: registry.find("tab-notify", "test"),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      }));
      await session.bindExtensions({
        mode: scenario.mode,
        uiContext: { setTitle: (title: string) => titles.push(title) } as never,
        onError: (error) => errors.push(error),
      });
      let requested = false;
      faux.setResponses([
        scenario.abort
          ? async (_context, options) => {
              requested = true;
              // Hold the request open until the user aborts it.
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                options?.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
              return fauxAssistantMessage("Too late.");
            }
          : fauxAssistantMessage("Explained the change."),
      ]);
      const pending = session.prompt("Explain the change.");
      if (scenario.abort) {
        for (let index = 0; index < 100 && !requested; index++) await flush();
        assert.ok(requested, "the provider request is in flight");
        await session.abort();
      }
      await pending;
      // Settlement may poll for idleness on a short timer before it settles.
      for (let index = 0; index < 40 && settled.length === 0; index++) await flush();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(settled, [scenario.abort]);
      assert.deepEqual(writes, scenario.expected(basename(cwd)));
      assert.deepEqual(errors, []);
      // A cancelled run returns to the bare project title instead of `review`.
      if (scenario.mode === "tui")
        assert.equal(titles.at(-1), scenario.abort ? `pi · ${basename(cwd)}` : `pi · ${basename(cwd)} · review`);
      else assert.deepEqual(titles, []);
    } finally {
      session?.dispose();
      write.mockRestore();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
