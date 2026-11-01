/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Every other agent-runner test mocks `@earendil-works/pi-coding-agent`: it
 * asserts that `runAgent` hands the right `tools:` allowlist to a *simulated*
 * `createAgentSession`. That proves our allowlist math, but not the assumption
 * the math rests on — that real pi-mono actually gates a session to that
 * allowlist, admitting extension-registered tools (the #47 fix) and dropping
 * the rest.
 *
 * This test closes that loop with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` loads it via `additionalExtensionPaths`,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert what the LLM
 *     would actually be allowed to call.
 *
 * No network/LLM: a faux Model object satisfies `createAgentSession`'s `model`
 * param, and we never depend on a turn completing — the assertion is on the
 * gated tool set, which is fixed at construction. (Driving a live faux model
 * through `session.prompt()` is intentionally avoided: under Vite the faux
 * provider registers in a different `pi-ai` module instance than the one
 * pi-coding-agent streams through, which is brittle and orthogonal to gating.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    // Only used as a valid Model object for createAgentSession; we never rely
    // on it actually streaming (we assert on the pre-prompt gated tool set).
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Register `cfg` as agent type "e2e", run it through the REAL runAgent, and
   * return the real session's active tool names captured at construction time.
   */
  async function activeToolsFor(cfg: Partial<AgentConfig>): Promise<string[]> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: BUILTINS,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
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
      runtime: {
        getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getAuth: async () => ({ apiKey: "faux" }),
        stream: () => { throw new Error("fixture has no provider dispatch"); },
        streamSimple: () => { throw new Error("fixture has no provider dispatch"); },
        hasConfiguredAuth: () => true,
      },
    };
    const ctx: any = { cwd, isProjectTrusted: () => true, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let active: string[] = [];
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        model,
        onSessionCreated: (s) => {
          active = s.getActiveToolNames();
        },
      });
    } catch {
      // A no-op/erroring prompt turn is fine — the gated tool set is fixed at
      // construction, which `onSessionCreated` already captured.
    }
    return active;
  }

  it("real pi-mono admits an extension-registered tool when it's in the allowlist (#47)", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE] });
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when extensions are disabled (not loaded)", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("disallowedTools removes a real extension tool from the live session", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE], disallowedTools: [EXT_TOOL] });
    expect(active).not.toContain(EXT_TOOL); // loaded, then denied at construction
    expect(active).toContain("read");
  });

  it("the ext: allowlist flip mutes a loaded-but-unselected extension in real pi-mono", async () => {
    // Extension loads (extensions: [FIXTURE]), but a single ext: selector for a
    // *different* name flips extension tools to an allowlist — the unselected
    // fixture contributes nothing, even though it loaded and ran its handlers.
    const active = await activeToolsFor({ extensions: [FIXTURE], extSelectors: ["ext:not-the-fixture"] });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext: selector surfaces the loaded extension's tool through the flip", async () => {
    // Derive the canonical name the loader/selector matcher uses, so the test
    // tracks `extensionCanonicalName` rather than hard-coding a filename form.
    const canon = extensionCanonicalName(FIXTURE);
    const active = await activeToolsFor({
      extensions: [FIXTURE],
      builtinToolNames: ["read"],
      extSelectors: [`ext:${canon}`],
    });
    expect(active).toContain(EXT_TOOL); // selected → surfaces despite the flip
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // builtinToolNames: ["read"] only
  });
  // An append-mode child inherits the parent's rendered prompt as its preamble,
  // and its own session renders skills and cwd after it. The parent's copies of
  // those sections must not be inherited, or the child lists them twice.
  describe("append mode inherits a real Pi 1.4 parent prompt without its skills and cwd", () => {
    let agentDir: string;
    let previousAgentDir: string | undefined;

    beforeEach(() => {
      agentDir = mkdtempSync(join(tmpdir(), "subagents-e2e-agent-"));
      previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      mkdirSync(join(agentDir, "skills", "demo-skill"), { recursive: true });
      writeFileSync(join(agentDir, "skills", "demo-skill", "SKILL.md"),
        "---\nname: demo-skill\ndescription: A demo skill for the prompt test.\n---\n\nDemo.\n");
      writeFileSync(join(cwd, "AGENTS.md"), "PROJECT RULE: say hi.\n");
    });
    afterEach(() => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    });

    /** The prompt a real Pi session renders for `cwd`: preamble, project context, skills, cwd. */
    async function realParentPrompt(): Promise<string> {
      const provider = fauxProvider({ provider: "prompt-parent", models: [{ id: "parent", contextWindow: 200_000 }] });
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
      runtime.registerNativeProvider(provider.provider);
      await runtime.refresh({ allowNetwork: false });
      const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({}), model: provider.getModel(), modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime),
      });
      const prompt = session.systemPrompt;
      session.dispose();
      return prompt;
    }

    async function childPrompt(parentPrompt: string, skills: AgentConfig["skills"]): Promise<string> {
      registerAgents(new Map([["twin", {
        name: "twin", description: "twin", builtinToolNames: BUILTINS, extensions: false, skills,
        systemPrompt: "", promptMode: "append", inheritContext: false, runInBackground: false, isolated: false,
      } as AgentConfig]]));
      const model = faux.getModel();
      const modelRegistry: any = {
        find: () => model, getAll: () => [model], getAvailable: () => [model],
        hasConfiguredAuth: () => true, isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
        registerProvider: () => {}, unregisterProvider: () => {},
        runtime: {
          getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
          getAuth: async () => ({ apiKey: "faux" }),
          stream: () => { throw new Error("fixture has no provider dispatch"); },
          streamSimple: () => { throw new Error("fixture has no provider dispatch"); },
          hasConfiguredAuth: () => true,
        },
      };
      const ctx: any = { cwd, isProjectTrusted: () => true, getSystemPrompt: () => parentPrompt, model, modelRegistry };
      let prompt = "";
      try {
        await runAgent(ctx, "twin", "go", { pi: makePi(), model, onSessionCreated: (s) => { prompt = s.systemPrompt; } });
      } catch {
        // Only the prompt built at construction matters.
      }
      return prompt;
    }

    const count = (text: string, needle: string) => text.split(needle).length - 1;

    it("skills: true lists the skills and the cwd once, and keeps the project context", async () => {
      const parent = await realParentPrompt();
      expect(count(parent, "<name>demo-skill</name>")).toBe(1);
      expect(count(parent, "<cwd>")).toBe(1);
      expect(parent).toContain("PROJECT RULE: say hi.");

      const child = await childPrompt(parent, true);
      expect(count(child, "<name>demo-skill</name>")).toBe(1);
      expect(count(child, "<available_skills>")).toBe(1);
      expect(count(child, "<cwd>")).toBe(1);
      expect(count(child, "PROJECT RULE: say hi.")).toBe(1);
      // The inherited part is still a byte prefix of the parent's prompt.
      expect(child.startsWith(parent.slice(0, parent.indexOf("\n\n<skills>\n")))).toBe(true);
    });

    it("skills: false shows none of the parent's skills", async () => {
      const child = await childPrompt(await realParentPrompt(), false);
      expect(child).not.toContain("demo-skill");
      expect(child).toContain("PROJECT RULE: say hi.");
    });
  });
});
