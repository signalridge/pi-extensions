/**
 * supervisor.test.ts — `contact_supervisor`, the child→parent direction.
 *
 * The tool interrupts a person, so the two things worth pinning are when it
 * exists at all and what it does when nobody answers: a child whose question
 * goes unanswered must be told to carry on, never left waiting or failed.
 */
import { describe, expect, it, vi } from "vitest";
import { createSupervisorTool } from "../src/supervisor.js";

const ask = (overrides: Partial<{ input: any; select: any }> = {}) => ({
  input: vi.fn(async () => "answered"),
  select: vi.fn(async (_title: string, options: string[]) => options[0]),
  ...overrides,
});

const build = (askImpl = ask(), agentLabel = "Reviewer") =>
  createSupervisorTool({ ask: askImpl, agentLabel });

const only = (tools: ReturnType<typeof createSupervisorTool>) => {
  expect(tools).toHaveLength(1);
  return tools[0];
};

const run = (tool: ReturnType<typeof only>, params: Record<string, unknown>) =>
  (tool.execute as any)("call-1", params, undefined, undefined, undefined);

const textOf = (result: any) => result.content[0].text as string;

describe("availability", () => {
  // Injecting a tool whose every call is an error spends context teaching the
  // model an affordance it does not have — the same reason nested tools are
  // withheld rather than stubbed when nesting is off.
  it("is not injected when there is no human to ask", () => {
    expect(createSupervisorTool({ agentLabel: "Reviewer" })).toEqual([]);
  });

  it("is injected when a UI is available", () => {
    expect(build()).toHaveLength(1);
  });

  it("is named `contact_supervisor`", () => {
    expect(only(build()).name).toBe("contact_supervisor");
  });

  // The description has to earn the interruption: a model that reads it as a
  // general-purpose clarification channel will use it constantly.
  it("tells the model to prefer an assumption over interrupting", () => {
    const description = only(build()).description ?? "";
    expect(description).toMatch(/interrupts a person/i);
    expect(description).toMatch(/prefer stating an assumption/i);
  });
});

describe("asking", () => {
  it("puts a free-text question to the human and returns the answer", async () => {
    const asker = ask();
    const result = await run(only(build(asker)), {
      question: "Which database?",
    });
    expect(asker.input).toHaveBeenCalled();
    expect(textOf(result)).toContain("answered");
  });

  it("names the asking agent in the prompt title", async () => {
    const asker = ask();
    await run(only(build(asker, "Migration Planner")), {
      question: "Which database?",
    });
    expect(asker.input.mock.calls[0][0]).toContain("Migration Planner");
  });

  it("uses a picker when the child offers concrete options", async () => {
    const asker = ask();
    const result = await run(only(build(asker)), {
      question: "Which database?",
      options: ["postgres", "sqlite"],
    });
    expect(asker.select).toHaveBeenCalled();
    expect(asker.input).not.toHaveBeenCalled();
    expect(asker.select.mock.calls[0][1]).toEqual(["postgres", "sqlite"]);
    expect(textOf(result)).toContain("postgres");
  });

  it("falls back to free text when every option is blank", async () => {
    const asker = ask();
    await run(only(build(asker)), { question: "Which?", options: ["", "   "] });
    expect(asker.input).toHaveBeenCalled();
    expect(asker.select).not.toHaveBeenCalled();
  });

  it("caps the number of options so the picker stays usable", async () => {
    const asker = ask();
    await run(only(build(asker)), {
      question: "Pick",
      options: Array.from({ length: 30 }, (_, i) => `option-${i}`),
    });
    expect(asker.select.mock.calls[0][1].length).toBeLessThanOrEqual(8);
  });

  it("refuses an empty question rather than prompting with nothing", async () => {
    const asker = ask();
    const result = await run(only(build(asker)), { question: "   " });
    expect(result.isError).toBe(true);
    expect(asker.input).not.toHaveBeenCalled();
  });
});

// A question that goes unanswered must leave the child able to finish. Any
// other outcome turns a dismissed dialog into a stalled or failed agent.
describe("when nobody answers", () => {
  it("tells the child to proceed when the human dismisses the prompt", async () => {
    const result = await run(
      only(build(ask({ input: vi.fn(async () => undefined) }))),
      {
        question: "Which database?",
      },
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/did not answer/i);
    expect(textOf(result)).toMatch(/best judgement/i);
  });

  it("treats a whitespace-only answer as no answer", async () => {
    const result = await run(
      only(build(ask({ input: vi.fn(async () => "   ") }))),
      {
        question: "Which database?",
      },
    );
    expect(textOf(result)).toMatch(/did not answer/i);
  });

  it("does not fail the run when the dialog cannot open", async () => {
    const result = await run(
      only(
        build(
          ask({
            input: vi.fn(async () => {
              throw new Error("no interactive terminal");
            }),
          }),
        ),
      ),
      { question: "Which database?" },
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/could not reach the supervisor/i);
    expect(textOf(result)).toContain("no interactive terminal");
  });
});

// The question and its options are model-authored text drawn into the user's
// terminal, so they get the same treatment as any other child-supplied string.
describe("untrusted child text", () => {
  it("neutralizes an escape sequence in the question", async () => {
    const asker = ask();
    await run(only(build(asker)), { question: "evil\u001B[31mred" });
    expect(asker.input.mock.calls[0][1]).not.toContain("\u001B[");
  });

  it("neutralizes an escape sequence in an option label", async () => {
    const asker = ask();
    await run(only(build(asker)), {
      question: "Pick",
      options: ["evil[31mred", "safe"],
    });
    expect(asker.select.mock.calls[0][1][0]).not.toContain("[");
  });

  it("bounds a very long question", async () => {
    const asker = ask();
    await run(only(build(asker)), { question: "x".repeat(10_000) });
    expect(asker.input.mock.calls[0][1].length).toBeLessThanOrEqual(2_000);
  });

  it("bounds a very long option label", async () => {
    const asker = ask();
    await run(only(build(asker)), {
      question: "Pick",
      options: ["y".repeat(1_000), "short"],
    });
    expect(asker.select.mock.calls[0][1][0].length).toBeLessThanOrEqual(200);
  });
});
