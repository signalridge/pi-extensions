/**
 * saved-record-retrieval.test.ts — get_subagent_result after the live record is gone.
 *
 * The live record is evicted ten minutes after the agent finishes, read or not,
 * and a reload drops it at once. Every top-level settle also appends a
 * `subagents:record` entry; get_subagent_result answers from the latest one on
 * the current branch. A second activation over the same branch is the reload
 * case, and the same lookup as an evicted record: the manager has no record.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

type Entry = { type: string; customType: string; data: unknown };
const textOf = (result: any): string => result.content[0].text;

let cwd = "";
let previousCwd = "";
let previousAgentDir: string | undefined;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "saved-record-"));
  previousCwd = process.cwd();
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
  process.chdir(cwd);
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

/** Shut the current activation down and release its global registry slots. */
async function release(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
  for (const key of ["pi-subagents:manager", "pi-subagents:manager-active", "pi-subagents:rpc-owner"]) {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)];
  }
}

afterEach(async () => {
  await release();
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
});

function context(branch: Entry[]) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { ...mockParentRegistry, find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

/** Activate the extension with `appendEntry` landing on `branch`, as Pi's session does. */
async function activate(branch: Entry[]) {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data })),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  const bindCtx = context(branch);
  bindCtx.sessionManager.getSessionId = vi.fn(() => undefined);
  await lifecycle.get("session_start")?.({}, bindCtx);
  shutdown = async () => { await lifecycle.get("session_shutdown")?.({}, bindCtx); };
  return tools;
}

/** Run a foreground agent (and optionally resume it) in a first activation, then shut it down. */
async function finishedAgent(branch: Entry[], run: Partial<RunResult> = {}, resumed?: Awaited<ReturnType<typeof resumeAgent>>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-FULL-RESULT",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
    ...run,
  });
  const tools = await activate(branch);
  const spawned = await tools.get("Agent").execute("tc-spawn",
    { prompt: "Review the change.", description: "Review the change", subagent_type: "general-purpose" },
    undefined, undefined, context(branch));
  const id = spawned.details.agentId as string;
  if (resumed) {
    vi.mocked(resumeAgent).mockResolvedValue(resumed);
    await tools.get("Agent").execute("tc-resume",
      { prompt: "Continue.", description: "Continue", subagent_type: "general-purpose", resume: id },
      undefined, undefined, context(branch));
  }
  await release();
  return id;
}

/** get_subagent_result in a fresh activation over the same branch. */
async function readAfterReload(branch: Entry[], agentId: string): Promise<string> {
  const tools = await activate(branch);
  try {
    return textOf(await tools.get("get_subagent_result").execute("tc-read", { agent_id: agentId }, undefined, undefined, context(branch)));
  } finally {
    await release();
  }
}

describe("get_subagent_result answers from the saved record once the live one is gone", () => {
  it("returns the saved result of a finished agent", async () => {
    const branch: Entry[] = [];
    const id = await finishedAgent(branch);
    expect(branch.filter(entry => entry.customType === "subagents:record")).toHaveLength(1);

    const out = await readAfterReload(branch, id);
    expect(out).toContain(`Agent: ${id}`);
    expect(out).toContain("Status: completed");
    expect(out).toContain("saved record");
    expect(out).toContain("THE-FULL-RESULT");
  });

  it("answers with a foreground resume's outcome, not the earlier run's", async () => {
    const branch: Entry[] = [];
    const id = await finishedAgent(branch, {}, { text: "THE-RESUMED-RESULT", aborted: false, steered: false });
    expect(branch.filter(entry => entry.customType === "subagents:record")).toHaveLength(2);

    const out = await readAfterReload(branch, id);
    expect(out).toContain("THE-RESUMED-RESULT");
    expect(out).not.toContain("THE-FULL-RESULT");
  });

  it("keeps a failed run's partial output, labelled as partial", async () => {
    const branch: Entry[] = [];
    const id = await finishedAgent(branch, { responseText: "THE-PARTIAL-OUTPUT", failure: "provider error" });

    const out = await readAfterReload(branch, id);
    expect(out).toContain("Status: error");
    expect(out).toContain("Error: provider error\n\nPartial output before the failure:\nTHE-PARTIAL-OUTPUT");
  });

  it("reports an id with no well-formed saved record as not found", async () => {
    const branch: Entry[] = [];
    const id = await finishedAgent(branch);
    // Any extension can append this customType; a malformed payload is not an answer.
    const forged: Entry[] = [
      { type: "custom", customType: "subagents:record", data: { id: "forged", type: "general-purpose", description: "x", status: "running", startedAt: 1 } },
      { type: "custom", customType: "subagents:record", data: { id: "forged-2", type: "general-purpose", description: "x", status: "completed", result: 7, startedAt: 1 } },
    ];
    branch.push(...forged);

    expect(await readAfterReload(branch, "forged")).toContain("Agent not found");
    expect(await readAfterReload(branch, "forged-2")).toContain("Agent not found");
    expect(await readAfterReload(branch, `${id}-other`)).toContain("Agent not found");
  });
});
