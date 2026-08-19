/**
 * agent-refine-wizard.test.ts — `/agents → <agent> → Refine with Claude`.
 *
 * Refining edits something the user already depends on, which is what separates
 * it from the generate wizard. Three properties carry that weight:
 *
 *  - the child NEVER touches the file. It runs under the symbol-keyed zero-tool
 *    policy and returns text; the parent validates and commits.
 *  - a malformed or unchanged result writes nothing at all.
 *  - the previous version can be restored immediately, and the restore is
 *    itself guarded — it must not clobber a third party's edit.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { AGENT_DEFINITION_GENERATION_OVERRIDE, INTERNAL_AGENT_CONFIG_OVERRIDE } from "../src/internal-run.js";

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, commands, lifecycle };
}

function sessionContext(cwd: string) {
  return {
    hasUI: true,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => undefined), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const AGENT_NAME = "reviewer";
const BEFORE = "---\ndescription: Reviews code\ntools: read\n---\n\nOriginal body.\n";
const AFTER = "---\ndescription: Reviews code carefully\ntools: read, grep\n---\n\nRevised body.\nExtra line.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  cwd = mkdtempSync(join(tmpdir(), "pi-agent-refine-"));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(cwd, "global-agent-dir");
  process.env.HOME = cwd;
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];
  delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
  registerAgents(new Map());
  process.chdir(originalCwd);
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Drive `/agents → reviewer → Refine with Claude`.
 *
 * `keep` answers the post-write "Keep the refined agent?" prompt; the two
 * confirms are answered in order, so `apply: false` never reaches `keep`.
 */
async function runRefine(options: {
  result: string;
  apply?: boolean;
  keep?: boolean;
  mutateDuringRun?: string;
  mutateAfterWrite?: string;
}) {
  const agentsDir = join(cwd, ".pi", "agents");
  const agentPath = join(agentsDir, `${AGENT_NAME}.md`);
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(agentPath, BEFORE);

  let prompt = "";
  let runOptions: Parameters<typeof runAgent>[3] | undefined;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, refinePrompt, optionsForRun) => {
    prompt = refinePrompt;
    runOptions = optionsForRun;
    if (options.mutateDuringRun !== undefined) writeFileSync(agentPath, options.mutateDuringRun);
    return {
      responseText: options.result,
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as any;
  });

  const { pi, commands, lifecycle } = makePi();
  subagentsExtension(pi);
  await lifecycle.get("session_start")?.({}, sessionContext(cwd));
  shutdown = async () => {
    await lifecycle.get("session_shutdown")?.({}, sessionContext(cwd));
  };

  const notices: { message: string; level: string }[] = [];
  const confirmAnswers = [options.apply ?? true, options.keep ?? true];
  let confirmIndex = 0;
  let agentsMenuShown = 0;
  // Each menu answers ONCE and then unwinds by returning undefined. Every one
  // of these surfaces reopens after its child returns, so a mock that keeps
  // answering the same way loops forever instead of finishing the flow.
  let typesListShown = 0;
  let detailShown = 0;
  const ui = {
    select: vi.fn(async (title: string, choices: string[]) => {
      if (title === "Agents") {
        return agentsMenuShown++ === 0 ? choices.find((c) => c.startsWith("Agent types (")) : undefined;
      }
      if (title === AGENT_NAME) {
        return detailShown++ === 0 ? choices.find((c) => c === "Refine with Claude") : undefined;
      }
      return undefined;
    }),
    custom: vi.fn(async () => (typesListShown++ === 0 ? AGENT_NAME : undefined)),
    input: vi.fn(async () => "make it stricter"),
    confirm: vi.fn(async () => {
      const answer = confirmAnswers[confirmIndex] ?? false;
      confirmIndex++;
      if (options.mutateAfterWrite !== undefined && confirmIndex === 2) {
        writeFileSync(agentPath, options.mutateAfterWrite);
      }
      return answer;
    }),
    notify: vi.fn((message: string, level: string) => notices.push({ message, level })),
    editor: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };

  return {
    agentPath,
    ui,
    notices,
    // Getters, not values: both are populated when the command runs, which is
    // after this object is built.
    getPrompt: () => prompt,
    getRunOptions: () => runOptions,
    commands,
    sessionContext: () => ({ ...sessionContext(cwd), ui }),
  };
}

/** Invoke the refine flow directly on the detail menu for `reviewer`. */
async function refine(options: Parameters<typeof runRefine>[0]) {
  const harness = await runRefine(options);
  await harness.commands.get("agents").handler("", harness.sessionContext());
  return harness;
}

describe("refine wizard — the child cannot touch the file", () => {
  it("runs the refinement under the zero-tool generation policy", async () => {
    const harness = await refine({ result: AFTER });
    const runOptions = harness.getRunOptions();
    expect(runOptions?.[INTERNAL_AGENT_CONFIG_OVERRIDE]).toBe(AGENT_DEFINITION_GENERATION_OVERRIDE);
  });

  it("hands the model the current file and tells it to return the whole file", async () => {
    const harness = await refine({ result: AFTER });
    expect(harness.getPrompt()).toContain("Original body.");
    expect(harness.getPrompt()).toContain("make it stricter");
    expect(harness.getPrompt()).toMatch(/whole file, not a diff/i);
  });
});

describe("refine wizard — what reaches disk", () => {
  it("writes the refined definition once applied", async () => {
    const harness = await refine({ result: AFTER });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(AFTER);
  });

  it("writes nothing when the refinement is declined", async () => {
    const harness = await refine({ result: AFTER, apply: false });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(BEFORE);
  });

  it("writes nothing when the model returns a malformed definition", async () => {
    const harness = await refine({ result: "no frontmatter here" });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(BEFORE);
    expect(harness.notices.some((n) => /malformed/i.test(n.message))).toBe(true);
  });

  it("writes nothing when the model returns the file unchanged", async () => {
    const harness = await refine({ result: BEFORE });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(BEFORE);
    expect(harness.notices.some((n) => /unchanged/i.test(n.message))).toBe(true);
  });

  // The commit is against the snapshot read BEFORE the run, so an editor that
  // changed the file meanwhile makes the commit fail rather than lose the edit.
  it("refuses to overwrite an edit that landed while the model was working", async () => {
    const concurrent = "---\ndescription: Someone else edited this\n---\n\nTheirs.\n";
    const harness = await refine({ result: AFTER, mutateDuringRun: concurrent });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(concurrent);
  });
});

describe("refine wizard — rollback", () => {
  it("restores the previous version when the refinement is rejected", async () => {
    const harness = await refine({ result: AFTER, keep: false });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(BEFORE);
    expect(harness.notices.some((n) => /restored/i.test(n.message))).toBe(true);
  });

  it("keeps the refinement when it is accepted", async () => {
    const harness = await refine({ result: AFTER, keep: true });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(AFTER);
  });

  // The restore expects the refined content, not the original: reverting must
  // not discard a third edit that arrived in between.
  it("refuses to restore over an edit made after the refinement landed", async () => {
    const later = "---\ndescription: Edited after the refinement\n---\n\nLater.\n";
    const harness = await refine({ result: AFTER, keep: false, mutateAfterWrite: later });
    expect(readFileSync(harness.agentPath, "utf-8")).toBe(later);
    expect(harness.notices.some((n) => /could not restore/i.test(n.message))).toBe(true);
  });
});
