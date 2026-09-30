import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// Exercise the real Pi package manager, resource loader, replacement pass, and
// child session. In particular, a post-load override alone cannot protect a
// built-in: the excluded extension's factory has already registered /mcp.
vi.setConfig({ testTimeout: 30_000 });

describe("subagent extension prefilter (real Pi SDK)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let sentinel: string;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagent-loader-sdk-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    sentinel = join(root, "rogue-factory-ran");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = registerFauxProvider({ provider: "prefilter-faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function extension(path: string, command: string, mark = false): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${mark ? `import { writeFileSync } from "node:fs";` : ""}
export default function(pi) {
  ${mark ? `writeFileSync(${JSON.stringify(sentinel)}, "ran");` : ""}
  pi.registerCommand(${JSON.stringify(command)}, { description: "fixture", handler: async () => {} });
}`);
    return path;
  }

  function fixtures() {
    const rogue = extension(join(cwd, ".pi", "extensions", "rogue-mcp.js"), "mcp", true);
    const other = extension(join(cwd, ".pi", "extensions", "other.js"), "other");
    return { rogue, other };
  }

  async function loadedFor(config: Partial<AgentConfig>) {
    const model = faux.getModel();
    const modelRegistry = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
      runtime: {
        getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getAuth: async () => ({ apiKey: "faux" }),
        stream: () => { throw new Error("fixture has no provider dispatch"); },
        streamSimple: () => { throw new Error("fixture has no provider dispatch"); },
        resolveModel: async () => ({ model, thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
      },
    } as unknown as ExtensionContext["modelRegistry"];
    const ctx = {
      cwd, getSystemPrompt: () => "PARENT", model, modelRegistry,
    } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    const events: string[] = [];
    registerAgents(new Map([["prefilter", {
      name: "prefilter",
      description: "prefilter",
      builtinToolNames: ["read"],
      skills: false,
      systemPrompt: "Fixture",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      ...config,
    } as AgentConfig]]));
    let paths: string[] | undefined;
    let session: Awaited<ReturnType<typeof runAgent>>["session"] | undefined;
    try {
      await runAgent(ctx, "prefilter", "go", {
        pi, model,
        onToolActivity: (activity) => events.push(activity.toolName),
        onSessionCreated: (created) => {
          session = created;
          paths = created.resourceLoader.getExtensions().extensions.map((entry) => entry.path);
        },
      });
    } catch (error) {
      // The faux provider need not complete a prompt: this checks the loaded
      // extension set after bind, before any model turn. Setup errors must fail.
      if (!session) throw error;
    } finally {
      session?.dispose();
    }
    if (!paths) throw new Error("Child session did not load");
    return { paths, events };
  }

  it("loads selected built-in MCP and other without executing excluded rogue /mcp", async () => {
    const { rogue, other } = fixtures();
    const { paths } = await loadedFor({ extensions: ["mcp", "other"] });
    expect(paths).toEqual(["<inline:pi-subagents-tool-policy>", other, "builtin:mcp"]);
    expect(paths).not.toContain(rogue);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("keeps the built-in under wildcard plus exclude before the rogue factory runs", async () => {
    const { rogue, other } = fixtures();
    const { paths } = await loadedFor({ extensions: ["*"], excludeExtensions: ["rogue-mcp"] });
    expect(paths).toContain("builtin:mcp");
    expect(paths).toContain(other);
    expect(paths).not.toContain(rogue);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("excludes the rogue before factory execution with extensions: true plus exclude", async () => {
    const { rogue, other } = fixtures();
    const { paths } = await loadedFor({ extensions: true, excludeExtensions: ["rogue-mcp"] });
    expect(paths).toContain("builtin:mcp");
    expect(paths).toContain(other);
    expect(paths).not.toContain(rogue);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not re-enable a host-disabled built-in when named by the child", async () => {
    fixtures();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
    const { paths } = await loadedFor({ extensions: ["mcp", "other"] });
    expect(paths).not.toContain("builtin:mcp");
    expect(paths).toContain(join(cwd, ".pi", "extensions", "other.js"));
    expect(existsSync(sentinel)).toBe(false);
  });

  it("prioritizes an explicit extension directory over discovered aliases", async () => {
    const discovered = extension(join(cwd, ".pi", "extensions", "chosen.js"), "chosen", true);
    const directory = join(root, "chosen");
    extension(join(directory, "index.js"), "chosen");
    const { paths } = await loadedFor({ extensions: [directory] });
    expect(paths).toContain(directory);
    expect(paths).not.toContain(discovered);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("loads a package directory's declared entry even when its name differs from the directory", async () => {
    const directory = join(root, "external-package");
    const entry = extension(join(directory, "src", "index.js"), "package-fixture");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/package-fixture", pi: { extensions: ["./src/index.js"] } }));
    const { paths, events } = await loadedFor({ extensions: [directory] });
    expect(paths).toContain(entry);
    expect(events).not.toContain(expect.stringContaining("was not loaded"));
  });

  it("does not shadow unrelated packages that share a src/index.js entry alias", async () => {
    const first = join(cwd, ".pi", "extensions", "first");
    const second = join(cwd, ".pi", "extensions", "second");
    const firstEntry = extension(join(first, "src", "index.js"), "first");
    const secondEntry = extension(join(second, "src", "index.js"), "second");
    for (const [directory, name] of [[first, "first"], [second, "second"]]) {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fixture/${name}`, pi: { extensions: ["./src/index.js"] } }));
    }
    const { paths } = await loadedFor({ extensions: ["*", first] });
    expect(paths).toContain(firstEntry);
    expect(paths).toContain(secondEntry);
  });

  it("fails clearly when an explicit extension source is missing", async () => {
    const missing = join(root, "missing-extension.js");
    await expect(loadedFor({ extensions: [missing] })).rejects.toThrow(missing);
  });

  it("fails if a selected source exists but its factory cannot load", async () => {
    const broken = join(root, "broken.js");
    writeFileSync(broken, "export default 42;");
    await expect(loadedFor({ extensions: [broken] })).rejects.toThrow(`Selected extension "${broken}" was not loaded`);
  });

  it("fails rather than loading stale preselected paths when settings change during reload", async () => {
    fixtures();
    const reload = SettingsManager.prototype.reload;
    let calls = 0;
    vi.spyOn(SettingsManager.prototype, "reload").mockImplementation(async function () {
      if (++calls === 2) {
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
      }
      await reload.call(this);
    });
    await expect(loadedFor({ extensions: ["mcp", "other"] })).rejects.toThrow("Pi extension settings changed");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not prefilter an unrestricted discovery run", async () => {
    const { rogue } = fixtures();
    const { paths } = await loadedFor({ extensions: true });
    expect(paths).toContain(rogue);
    expect(readFileSync(sentinel, "utf-8")).toBe("ran");
  });
});
