/**
 * resume-tool-call-id.test.ts — the completion notification for a background
 * RESUME must carry the resume's own tool call id.
 *
 * `record.toolCallId` is written when a background agent is spawned, and
 * `formatTaskNotification` emits it as `<tool-use-id>`. `manager.resume` clears
 * `resultConsumed`, so a resumed run notifies again — and if the resume left the
 * field alone, that notification would point the orchestrator at the tool call
 * the original spawn already answered.
 *
 * Driven through the real extension and the real Agent tool, with only
 * `runAgent` mocked, so the assertion is on what a caller actually receives.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>(
    "../src/agent-runner.js",
  );
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const sent: any[] = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      const previous = lifecycle.get(event);
      lifecycle.set(event, async (...args: unknown[]) => {
        await previous?.(...args);
        return handler(...args);
      });
    }),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn((message: any) => {
      sent.push(message);
    }),
  } as any;
  return { pi, tools, lifecycle, sent };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { ...mockParentRegistry, find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => "s1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
/** Past the 100 ms batch debounce and the 200 ms nudge hold. */
const settle = () => new Promise((r) => setTimeout(r, 450));

function notificationText(sent: any[]): string {
  const hit = sent
    .map((m) => String(m?.content ?? ""))
    .find((c) => c.includes("<task-notification>"));
  return hit ?? "";
}

describe("background resume re-anchors the tool call id", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-resume-tcid-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-resume-tcid-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false }),
    );
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reading a terminal result after the old hold window still suppresses delivery while the parent is busy", async () => {
    const { pi, tools, lifecycle, sent } = makePi();
    const root = ctx(); let idle = false;
    root.isIdle = () => idle; root.hasPendingMessages = () => false;
    subagentsExtension(pi); await lifecycle.get("session_start")?.({}, root);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "READ-RESULT", aborted: false, steered: false });
    const spawned = await tools.get("Agent").execute("spawn", { prompt: "work", description: "read", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, root);
    const id = textOf(spawned).match(/Agent ID: (\S+)/)?.[1]; expect(id).toBeTruthy();
    await settle(); expect(sent).toHaveLength(0);
    const read = await tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, root);
    expect(textOf(read)).toContain("READ-RESULT"); idle = true;
    await lifecycle.get("agent_settled")?.({}, root); await settle(); expect(sent).toHaveLength(0);
    await lifecycle.get("session_shutdown")?.({}, root);
  });

  it("an unread failure stays available and wakes once at the settled boundary", async () => {
    const { pi, tools, lifecycle, sent } = makePi();
    const root = ctx(); let idle = false;
    root.isIdle = () => idle; root.hasPendingMessages = () => false;
    subagentsExtension(pi); await lifecycle.get("session_start")?.({}, root);
    vi.mocked(runAgent).mockRejectedValue(new Error("synthetic unread failure"));
    await tools.get("Agent").execute("spawn", { prompt: "work", description: "failed", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, root);
    await settle(); expect(sent).toHaveLength(0); idle = true;
    await lifecycle.get("agent_settled")?.({}, root); await settle();
    expect(sent).toHaveLength(1); expect(notificationText(sent)).toContain("synthetic unread failure");
    expect(pi.sendMessage.mock.calls[0]?.[1]).toMatchObject({ deliverAs: "steer", triggerTurn: true });
    await lifecycle.get("session_shutdown")?.({}, root);
  });

  it("notifies under the resume's tool call id, not the spawn's", async () => {
    const { pi, tools, lifecycle, sent } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, ctx());

    vi.mocked(runAgent).mockResolvedValue({
      responseText: "FIRST-RUN",
      // `subscribe` is required: the resume path wires streamToOutputFile onto
      // the live session to append the resumed turns to the existing transcript.
      session: {
        dispose: vi.fn(),
        messages: [],
        subscribe: vi.fn(() => vi.fn()),
      } as any,
      aborted: false,
      steered: false,
    });

    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      {
        prompt: "go",
        description: "A background agent",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "background spawn should surface an agent id").toBeTruthy();
    await settle();

    // Baseline: the spawn's own notification is stamped with the spawn's id, so
    // the field is populated and the resume assertion below is meaningful.
    expect(notificationText(sent)).toContain(
      "<tool-use-id>tc-spawn</tool-use-id>",
    );

    sent.length = 0;
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "SECOND-RUN",
      // `subscribe` is required: the resume path wires streamToOutputFile onto
      // the live session to append the resumed turns to the existing transcript.
      session: {
        dispose: vi.fn(),
        messages: [],
        subscribe: vi.fn(() => vi.fn()),
      } as any,
      aborted: false,
      steered: false,
    });

    await tools
      .get("Agent")
      .execute(
        "tc-resume",
        { resume: id, prompt: "again", run_in_background: true },
        undefined,
        undefined,
        ctx(),
      );
    await settle();

    expect(notificationText(sent)).toContain(
      "<tool-use-id>tc-resume</tool-use-id>",
    );

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
