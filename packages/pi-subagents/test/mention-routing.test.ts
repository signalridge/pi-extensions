import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});
const { runMentionClone } = vi.hoisted(() => ({ runMentionClone: vi.fn() }));
vi.mock("../src/mention-clone.js", async () => {
  const actual = await vi.importActual<typeof import("../src/mention-clone.js")>("../src/mention-clone.js");
  return { ...actual, runMentionClone };
});

import { runAgent } from "../src/agent-runner.js";
import { setDefaultsDisabled } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { MENTION_SPAWNED } from "../src/mention-clone.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

function activation() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return { handlers, tools, pi };
}

function ctx(cwd: string, sessionId = "session-1") {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()) },
    model: undefined,
    modelRegistry: { ...mockParentRegistry, find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

let cwd: string;
let originalCwd: string;
let originalHome: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  cwd = mkdtempSync(join(tmpdir(), "mention-routing-"));
  process.chdir(cwd);
  process.env.HOME = cwd;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
    agentMentions: "model", schedulingEnabled: false, outputTranscript: false,
  }));
  runMentionClone.mockReset();
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  setDefaultsDisabled(false);
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(cwd, { recursive: true, force: true });
});

describe("mention ownership across session boundaries", () => {
  it.each(["session_before_switch", "session_before_tree"])(
    "does not fall back into a replacement after %s, even with the same session ID",
    async (boundary) => {
      let release!: (value: { spawned: boolean; error: string }) => void;
      runMentionClone.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      const { handlers } = activation();
      const original = ctx(cwd);
      await handlers.get("session_start")?.({}, original);
      expect(await handlers.get("input")?.({ text: "@explore find it", source: "user" }, original)).toEqual({ action: "handled" });
      expect(runMentionClone).toHaveBeenCalledOnce();

      await handlers.get(boundary)?.({}, original);
      expect(runMentionClone.mock.calls[0][0].isOriginCurrent()).toBe(true);
      const replacement = ctx(cwd);
      await handlers.get(boundary === "session_before_tree" ? "session_tree" : "session_start")?.({}, replacement);
      expect(runMentionClone.mock.calls[0][0].isOriginCurrent()).toBe(false);
      release({ spawned: false, error: "provider failed" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(replacement.ui.notify).not.toHaveBeenCalled();
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
      expect(original.ui.notify).toHaveBeenCalledTimes(1); // only the initial Starting toast
      await handlers.get("session_shutdown")?.({}, replacement);
    },
  );

  it.each(["session_before_switch", "session_before_tree"])(
    "keeps mention routing live when a later handler cancels %s",
    async (boundary) => {
      let release!: (value: { spawned: boolean; error: string }) => void;
      runMentionClone.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      runMentionClone.mockResolvedValue({ spawned: true });
      vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
      const { handlers } = activation();
      const original = ctx(cwd);
      await handlers.get("session_start")?.({}, original);
      expect(await handlers.get("input")?.({ text: "@explore first", source: "user" }, original))
        .toEqual({ action: "handled" });

      await handlers.get(boundary)?.({}, original);
      // Pi would now return { cancel: true } from a later handler. There is no
      // committed session_tree/start/shutdown event and the old session remains.
      expect(runMentionClone.mock.calls[0][0].isOriginCurrent()).toBe(true);
      release({ spawned: false, error: "clone unavailable" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
      expect(await handlers.get("input")?.({ text: "@plan second", source: "user" }, original))
        .toEqual({ action: "handled" });
      expect(runMentionClone).toHaveBeenCalledTimes(2);
      expect(original.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Started @explore directly"), "warning");
      await handlers.get("session_shutdown")?.({}, original);
    },
  );

  it("does not bypass a hidden Agent policy refusal with direct spawn", async () => {
    runMentionClone.mockResolvedValue({ spawned: false, refused: true, error: "the Agent tool refused this mention" });
    const { handlers } = activation();
    const original = ctx(cwd);
    await handlers.get("session_start")?.({}, original);
    expect(await handlers.get("input")?.({ text: "@explore find it", source: "user" }, original))
      .toEqual({ action: "handled" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(original.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("the Agent tool refused this mention"),
      "warning",
    );
    await handlers.get("session_shutdown")?.({}, original);
  });

  it("revalidates the mentioned type before infrastructure fallback", async () => {
    let release!: (value: { spawned: boolean; error: string }) => void;
    runMentionClone.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { handlers } = activation();
    const original = ctx(cwd);
    await handlers.get("session_start")?.({}, original);
    expect(await handlers.get("input")?.({ text: "@explore find it", source: "user" }, original))
      .toEqual({ action: "handled" });

    setDefaultsDisabled(true);
    release({ spawned: false, error: "provider failed" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(original.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no longer available"),
      "error",
    );
    await handlers.get("session_shutdown")?.({}, original);
  });

  it("refuses a background Agent call synchronously without the parent runtime", async () => {
    const { handlers, tools, pi } = activation();
    const original = ctx(cwd);
    delete original.modelRegistry.runtime;
    await handlers.get("session_start")?.({}, original);
    await expect(tools.get("Agent").execute(
      "tc-no-runtime",
      { subagent_type: "Explore", prompt: "find it", description: "Find it", run_in_background: true },
      undefined, undefined, original,
    )).rejects.toThrow(/parent's model runtime is unavailable or incompatible/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:created", expect.anything());
    await handlers.get("session_shutdown")?.({}, original);
  });

  it("does not start a model mention or its fallback when the parent runtime is unavailable", async () => {
    const { handlers } = activation();
    const original = ctx(cwd);
    delete original.modelRegistry.runtime;
    await handlers.get("session_start")?.({}, original);
    expect(await handlers.get("input")?.({ text: "@explore find it", source: "user" }, original))
      .toEqual({ action: "handled" });
    expect(runMentionClone).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(original.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("parent's model runtime is unavailable or incompatible"), "error",
    );
    expect(original.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Started"), expect.anything());
    await handlers.get("session_shutdown")?.({}, original);
  });

  it("does not announce a direct mention as Started without the parent runtime", async () => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      agentMentions: "direct", schedulingEnabled: false, outputTranscript: false,
    }));
    const { handlers } = activation();
    const original = ctx(cwd);
    delete original.modelRegistry.runtime;
    await handlers.get("session_start")?.({}, original);
    expect(await handlers.get("input")?.({ text: "@explore find it", source: "user" }, original))
      .toEqual({ action: "handled" });
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(original.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("parent's model runtime is unavailable or incompatible"), "error",
    );
    expect(original.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Started"), expect.anything());
    await handlers.get("session_shutdown")?.({}, original);
  });

  it("acknowledges a real Agent spawn before a post-spawn event throws", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
    const { handlers, tools, pi } = activation();
    const original = ctx(cwd);
    await handlers.get("session_start")?.({}, original);
    pi.events.emit.mockImplementation((name: string) => {
      if (name === "subagents:created") throw new Error("event observer failed");
    });
    const marked = vi.fn();

    await expect(tools.get("Agent").execute(
      undefined,
      { subagent_type: "Explore", prompt: "find it", description: "Find it", run_in_background: true, [MENTION_SPAWNED]: marked },
      undefined, undefined, original,
    )).rejects.toThrow("event observer failed");
    expect(marked).toHaveBeenCalledOnce();
    expect(marked).toHaveBeenCalledWith(expect.any(String));
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    await handlers.get("session_shutdown")?.({}, original);
  });
});
