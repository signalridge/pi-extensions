import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ParentQuestionHandler } from "../src/parent-questions.js";
import { createSupervisorTool } from "../src/supervisor.js";

function build(parentQuestion: ParentQuestionHandler) {
  const tools = createSupervisorTool({ parentQuestion });
  expect(tools).toHaveLength(1);
  return tools[0];
}

const context = {} as ExtensionContext;

describe("host-only supervisor questions", () => {
  it("withholds the tool without a manager-issued channel, even with a human UI", () => {
    const ask = { input: vi.fn(), select: vi.fn() };
    const legacyContext = { parentQuestion: undefined, ask, agentLabel: "Implement" };
    expect(createSupervisorTool(legacyContext)).toEqual([]);
    expect(ask.input).not.toHaveBeenCalled();
    expect(ask.select).not.toHaveBeenCalled();
  });

  it("ignores legacy UI fields without reading getters or emitting notices", async () => {
    const parentQuestion = vi.fn<ParentQuestionHandler>().mockResolvedValue({ status: "answered", answer: "Use existing." });
    const readLegacy = vi.fn((): never => { throw new Error("Legacy UI must not be read"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacyContext = { get ask() { return readLegacy(); }, get agentLabel() { return readLegacy(); } };
      expect(createSupervisorTool(legacyContext)).toEqual([]);
      // Preserve descriptors: object spread would invoke the getters itself.
      const tools = createSupervisorTool(Object.defineProperties({ parentQuestion }, Object.getOwnPropertyDescriptors(legacyContext)));
      expect(tools).toHaveLength(1);
      const result = await tools[0].execute("question", { question: "Which?" }, undefined, undefined, context);
      expect(result.details).toEqual({ status: "answered", answer: "Use existing." });
      expect(readLegacy).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("sends the original bounded question and choices to the host, never the human UI", async () => {
    const parentQuestion = vi.fn<ParentQuestionHandler>().mockResolvedValue({ status: "answered", answer: "Use the existing report." });
    const ask = { input: vi.fn(), select: vi.fn() };
    const tools = createSupervisorTool({ parentQuestion, ...{ ask } });
    const controller = new AbortController();
    const result = await tools[0].execute("question", { question: "Which report?", options: ["existing", "new"] }, controller.signal, undefined, context);
    expect(parentQuestion).toHaveBeenCalledWith("Which report?", ["existing", "new"], controller.signal);
    expect(result.details).toEqual({ status: "answered", answer: "Use the existing report." });
    expect(result.content[0].text).toContain("NOT human approval or a permission grant");
    expect(ask.input).not.toHaveBeenCalled();
    expect(ask.select).not.toHaveBeenCalled();
  });

  it.each(["timeout", "declined", "cancelled", "host unavailable"])("returns %s as no answer without a human fallback", async (reason) => {
    const parentQuestion = vi.fn<ParentQuestionHandler>().mockResolvedValue({ status: "unanswered", reason });
    const result = await build(parentQuestion).execute("question", { question: "Missing input?" }, undefined, undefined, context);
    expect(result.details).toEqual({ status: "unanswered", reason });
    expect(result.content[0].text).toContain("No answer");
    expect(result.content[0].text).toContain("existing authorization");
    expect(result.content[0].text).toContain("report the blocker in your final result");
  });

  it("describes ordinary host clarification, not an approval channel", () => {
    const tool = build(async () => ({ status: "unanswered", reason: "declined" }));
    expect(tool.name).toBe("contact_supervisor");
    expect(tool.description).toContain("main agent");
    expect(tool.description).toContain("Never use this channel for permission");
    expect(tool.description).toContain("Prefer stating an assumption");
  });

  it("retains schema limits on questions and choices", () => {
    const tool = build(async () => ({ status: "unanswered", reason: "declined" }));
    const check = (args: unknown) => validateToolArguments(tool, { type: "toolCall", id: "probe", name: tool.name, arguments: args });
    expect(() => check({ question: "x".repeat(2_001) })).toThrow();
    expect(() => check({ question: "Choose", options: ["x".repeat(201)] })).toThrow();
    expect(() => check({ question: "Choose", options: Array.from({ length: 9 }, () => "option") })).toThrow();
    expect(() => check({ question: "Choose", options: ["yes", "no"] })).not.toThrow();
  });
});
