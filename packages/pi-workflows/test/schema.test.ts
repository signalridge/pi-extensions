import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/schema.js";

const task = (id: string, depends_on: string[] = []) => ({
  id,
  subagent_type: "Explore",
  description: `task ${id}`,
  prompt: `prompt ${id}`,
  depends_on,
});

describe("workflow schema", () => {
  it("normalizes optional fields and accepts a valid DAG", () => {
    expect(validateWorkflow({ name: "demo", tasks: [task("a"), task("b", ["a"])] })).toEqual({
      name: "demo",
      phases: [],
      tasks: [{ ...task("a"), depends_on: [] }, task("b", ["a"])],
      background: false,
    });
  });

  it("accepts semantic tiers on tasks and synthesis", () => {
    expect(
      validateWorkflow({
        name: "tiered",
        tasks: [{ ...task("a"), tier: "small" }],
        synthesis: { subagent_type: "Plan", prompt: "summarize", tier: "large" },
      }),
    ).toMatchObject({
      tasks: [{ tier: "small" }],
      synthesis: { tier: "large" },
    });
  });

  it("applies a run tier to tasks while preserving task and synthesis overrides", () => {
    const result = validateWorkflow({
      name: "tiered-run",
      tier: "medium",
      tasks: [{ ...task("a") }, { ...task("b"), tier: "small" }],
      synthesis: { subagent_type: "Plan", prompt: "summarize" },
    });

    expect(result.tier).toBe("medium");
    expect(result.tasks[0]?.tier).toBeUndefined();
    expect(result.tasks[1]?.tier).toBe("small");
    expect(result.synthesis?.tier).toBeUndefined();
  });

  it("rejects unsupported workflow tier names", () => {
    expect(() => validateWorkflow({ name: "x", tasks: [{ ...task("a"), tier: "high" }] })).toThrow(
      /one of small, medium, or large/,
    );
  });

  it("rejects duplicates, unknown references, and cycles", () => {
    expect(() => validateWorkflow({ name: "x", tasks: [task("a"), task("a")] })).toThrow(/duplicate task/);
    expect(() => validateWorkflow({ name: "x", tasks: [task("a", ["missing"])] })).toThrow(/unknown task/);
    expect(() => validateWorkflow({ name: "x", tasks: [task("a", ["b"]), task("b", ["a"])] })).toThrow(/cycle/);
  });

  it("rejects unknown phases and execution policy fields", () => {
    expect(() =>
      validateWorkflow({
        name: "x",
        phases: [{ id: "one", title: "One" }],
        tasks: [{ ...task("a"), phase: "two" }],
      }),
    ).toThrow(/unknown phase/);
    expect(() => validateWorkflow({ name: "x", tasks: [task("a")], model: "provider/model" })).toThrow(
      /unsupported field/,
    );
    expect(() => validateWorkflow({ name: "x", tasks: [{ ...task("a"), prompt: "" }] })).toThrow(/prompt/);
  });
});

describe("task inputs", () => {
  it("accepts and preserves a subset of depends_on", () => {
    const result = validateWorkflow({
      name: "chained",
      tasks: [task("a"), task("b"), { ...task("c", ["a", "b"]), inputs: ["a"] }],
    });
    expect(result.tasks[2]?.inputs).toEqual(["a"]);
  });

  it("leaves the key absent when inputs is not declared, keeping journaled definitions byte-stable", () => {
    const result = validateWorkflow({ name: "plain", tasks: [task("a")] });
    const [first] = result.tasks;
    if (!first) throw new Error("expected a task");
    expect("inputs" in first).toBe(false);
  });

  it("rejects an input that is not a declared dependency", () => {
    expect(() =>
      validateWorkflow({ name: "x", tasks: [task("a"), task("c"), { ...task("b", ["a"]), inputs: ["c"] }] }),
    ).toThrow(/input "c" is not one of its depends_on/);
  });

  it("rejects duplicate inputs", () => {
    expect(() =>
      validateWorkflow({ name: "x", tasks: [task("a"), { ...task("b", ["a"]), inputs: ["a", "a"] }] }),
    ).toThrow(/duplicate input "a"/);
  });

  it("rejects inputs on a task with no dependencies", () => {
    expect(() => validateWorkflow({ name: "x", tasks: [{ ...task("a"), inputs: ["a"] }] })).toThrow(
      /is not one of its depends_on/,
    );
  });
});
