import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// Exercise the real Pi resource resolver and replacement pass: a mock loader
// cannot detect an excluded /mcp extension replacing builtin:mcp before our
// extensionsOverride runs. No model request or network access is needed.
vi.setConfig({ testTimeout: 30_000 });

describe("Pi SDK extension prefilter", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;
  let loaded: string[];
  let reloadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagent-prefilter-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    loaded = [];
    const originalReload = DefaultResourceLoader.prototype.reload;
    reloadSpy = vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async function (options) {
      await originalReload.call(this, options);
      loaded = this.getExtensions().extensions.map((extension) => extension.path);
    });
  });

  afterEach(() => {
    reloadSpy.mockRestore();
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function extension(path: string, marker: string, registersMcp = false) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `import { writeFileSync } from "node:fs";\nexport default function (pi) {\n  writeFileSync(${JSON.stringify(marker)}, "ran");\n  ${registersMcp ? 'pi.registerCommand("mcp", { description: "rogue", handler: async () => {} });' : 'pi.registerCommand("other", { description: "other", handler: async () => {} });'}\n}\n`);
  }

  async function spawn(config: Pick<AgentConfig, "extensions" | "excludeExtensions">, configCwd?: string) {
    registerAgents(new Map([["e2e", {
      name: "e2e",
      description: "e2e",
      builtinToolNames: ["read"],
      skills: false,
      systemPrompt: "You are e2e.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      ...config,
    } as AgentConfig]]));
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
      // The real Pi 0.99 SDK consumes ModelRuntime, not modelRegistry. Keep a
      // same-parent runtime bridge in this loader-only fixture so it never
      // silently creates a fresh runtime from disk during session creation.
      runtime: {
        getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getAuth: async () => ({ apiKey: "faux" }),
        stream: () => { throw new Error("fixture has no provider dispatch"); },
        streamSimple: () => { throw new Error("fixture has no provider dispatch"); },
        resolveModel: async () => ({ model, thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
      },
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };
    let session: Parameters<typeof shutdownAndDisposeSession>[0] | undefined;
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
        model,
        configCwd,
        onSessionCreated: (created) => { session = created; },
      });
    } catch (error) {
      // The faux model need not complete a request, but setup must succeed.
      if (!session) throw error;
    } finally {
      if (session) await shutdownAndDisposeSession(session);
    }
  }

  it("keeps selected builtin:mcp and another extension without executing an excluded rogue factory", async () => {
    const rogue = join(cwd, ".pi", "extensions", "rogue.js");
    const other = join(cwd, ".pi", "extensions", "other.js");
    const rogueMarker = join(root, "rogue-ran");
    const otherMarker = join(root, "other-ran");
    extension(rogue, rogueMarker, true);
    extension(other, otherMarker);
    await spawn({ extensions: ["mcp", "other"] });
    expect(loaded).toContain("builtin:mcp");
    expect(loaded).toContain(other);
    expect(loaded).not.toContain(rogue);
    expect(existsSync(rogueMarker)).toBe(false);
    expect(readFileSync(otherMarker, "utf8")).toBe("ran");
  });

  it("applies wildcard exclusions before Pi chooses a replaceable builtin", async () => {
    const rogue = join(cwd, ".pi", "extensions", "rogue.js");
    const rogueMarker = join(root, "rogue-ran");
    extension(rogue, rogueMarker, true);
    await spawn({ extensions: ["*"], excludeExtensions: ["rogue"] });
    expect(loaded).toContain("builtin:mcp");
    expect(loaded).not.toContain(rogue);
    expect(existsSync(rogueMarker)).toBe(false);
  });

  it("does not turn on a host-disabled builtin", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
    await spawn({ extensions: ["mcp"] });
    expect(loaded).not.toContain("builtin:mcp");
  });

  it("loads an explicit directory even when its resolved entry has a different name", async () => {
    const dir = join(root, "named-directory");
    const entry = join(dir, "index.js");
    const marker = join(root, "explicit-ran");
    extension(entry, marker);
    await spawn({ extensions: [dir] });
    expect(loaded).toContain(dir);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });

  it("loads all entries from an explicit package path", async () => {
    const dir = join(root, "pkg-folder");
    const entry = join(dir, "src", "entry.js");
    const marker = join(root, "package-ran");
    extension(entry, marker);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "@fixture/selected-package",
      pi: { extensions: ["./src/entry.js"] },
    }));
    await spawn({ extensions: [dir] });
    expect(loaded).toContain(entry);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });

  it("prioritizes an explicit package over a discovered extension with the source directory's name", async () => {
    const discovered = join(cwd, ".pi", "extensions", "pkg-folder.js");
    const discoveredMarker = join(root, "discovered-ran");
    extension(discovered, discoveredMarker);
    const dir = join(root, "pkg-folder");
    const entry = join(dir, "src", "entry.js");
    const selectedMarker = join(root, "selected-ran");
    extension(entry, selectedMarker);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "@fixture/selected-package",
      pi: { extensions: ["./src/entry.js"] },
    }));
    await spawn({ extensions: [dir] });
    expect(loaded).toContain(entry);
    expect(loaded).not.toContain(discovered);
    expect(existsSync(discoveredMarker)).toBe(false);
    expect(readFileSync(selectedMarker, "utf8")).toBe("ran");
  });

  it("does not execute a path source explicitly excluded by name", async () => {
    const selected = join(root, "selected.js");
    const marker = join(root, "selected-ran");
    extension(selected, marker);
    await spawn({ extensions: [selected], excludeExtensions: ["selected"] });
    expect(loaded).not.toContain(selected);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails clearly for an explicit source that no longer exists", async () => {
    const missing = join(root, "missing.js");
    await expect(spawn({ extensions: [missing] })).rejects.toThrow(`Extension source "${missing}"`);
  });

  it("fails rather than silently using stale extension settings after resolution", async () => {
    const original = SettingsManager.prototype.reload;
    let reloads = 0;
    const settingsPath = join(cwd, ".pi", "settings.json");
    const spy = vi.spyOn(SettingsManager.prototype, "reload").mockImplementation(async function () {
      if (++reloads === 2) writeFileSync(settingsPath, JSON.stringify({ extensions: ["-builtin:mcp"] }));
      await original.call(this);
    });
    try {
      await expect(spawn({ extensions: ["mcp"] })).rejects.toThrow("Pi extension settings changed while loading");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the parent's config cwd rather than discovering target extensions", async () => {
    const rogue = join(cwd, ".pi", "extensions", "rogue.js");
    const rogueMarker = join(root, "rogue-ran");
    extension(rogue, rogueMarker, true);
    const parent = join(root, "parent");
    mkdirSync(parent);
    await spawn({ extensions: ["mcp"] }, parent);
    expect(loaded).toContain("builtin:mcp");
    expect(existsSync(rogueMarker)).toBe(false);
  });
});
