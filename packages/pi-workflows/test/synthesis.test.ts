import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../src/journal.js";
import { buildBoundedResultSection, buildResultBlock, buildSynthesisPrompt } from "../src/synthesis.js";

const run = (text: string): WorkflowRun => ({
  runId: "r",
  schemaVersion: 1,
  definition: {
    name: "s",
    phases: [],
    tasks: [{ id: "a", subagent_type: "Explore", description: "A", prompt: "A", depends_on: [] }],
    synthesis: { subagent_type: "general-purpose", prompt: "Summarize" },
    background: false,
  },
  status: "synthesizing",
  taskStatus: { a: "completed" },
  agentIds: { a: "agent-a" },
  taskResults: { a: { status: "completed", text, compactionCount: 0, updatedAt: 1 } },
  compactions: {},
  startedAt: 1,
  updatedAt: 1,
});

describe("bounded synthesis", () => {
  it("caps individual payloads and marks truncation", () => {
    const instance = run("x".repeat(10_000));
    const prompt = buildSynthesisPrompt(instance.definition, instance);
    expect(prompt).toContain("result_truncated=true");
    expect(prompt.length).toBeLessThan(48_000);
  });

  it("caps the base synthesis instruction and keeps the final prompt hard-bounded", () => {
    const instance = run("result");
    const definition = {
      ...instance.definition,
      synthesis: { subagent_type: "general-purpose", prompt: "instruction ".repeat(20_000) },
    };
    const prompt = buildSynthesisPrompt(definition, instance);
    expect(prompt.length).toBeLessThanOrEqual(48_000);
    expect(prompt).toContain("[truncated]");
    expect(prompt).toContain("Workflow task results:");
  });
});

describe("extracted result formatting", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    task: { id: "a", description: "A" },
    result: { status: "completed" as const, text: "short", compactionCount: 0, updatedAt: 1, ...overrides },
    fallbackStatus: "missing",
  });

  it("honors the journaled truncated flag even when the text fits the per-result cap", () => {
    // resultFromLifecycle pre-caps text, so a re-cap here can never observe the original overflow.
    expect(buildResultBlock(entry({ truncated: true }))).toContain("result_truncated=true");
    expect(buildResultBlock(entry())).toContain("result_truncated=false");
  });

  it("uses the explicit fallback status only when no journaled result exists", () => {
    const block = buildResultBlock({
      task: { id: "a", description: "A" },
      result: undefined,
      fallbackStatus: "missing",
    });
    expect(block).toContain("status=missing agent_id=unknown");
    expect(block).toContain("(no result)");
  });

  it("emits only the preamble plus an overflow marker when no block fits", () => {
    const marker = "\n\n[dependency input truncated: additional results omitted]";
    const section = buildBoundedResultSection(["Header:"], [entry(), entry()], {
      maxPerResult: 6_000,
      maxTotal: 70,
      overflowMarker: marker,
    });
    expect(section).toBe(`Header:${marker}`);
    expect(section.length).toBeLessThanOrEqual(70);
    expect(section).not.toContain("### a");
  });
});
