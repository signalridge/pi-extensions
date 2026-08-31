import { describe, expect, it } from "vitest";
import { buildAdHocWorkflowScript } from "../src/index.js";
import { type AgentRunOptions, runWorkflow } from "../src/runtime.js";

describe("/workflows run ad-hoc script", () => {
  it("safely gives the synthesizer the original prompt, plan, and graph ledger", async () => {
    const originalPrompt = 'Handle "quotes", $' + "{literal}, a backtick `, and\nnewlines";
    const script = buildAdHocWorkflowScript(originalPrompt);
    let plannerPrompt = "";
    let synthesizerPrompt = "";

    const result = await runWorkflow(script, {
      agent: {
        run: async (prompt: string, options?: AgentRunOptions) => {
          if (options?.label === "planner") {
            plannerPrompt = prompt;
            return JSON.stringify({
              tasks: [{ id: "worker", description: "Do the work", prompt: "worker prompt", dependsOn: [] }],
            });
          }
          if (options?.label === "synthesizer") {
            synthesizerPrompt = prompt;
            return "final answer";
          }
          return "worker result";
        },
      },
    });

    expect(result.result).toBe("final answer");
    expect(plannerPrompt).toContain(originalPrompt);
    const marker = "Original task, execution plan, and graph ledger:\n";
    const payload = JSON.parse(synthesizerPrompt.slice(synthesizerPrompt.indexOf(marker) + marker.length)) as {
      originalPrompt: string;
      plan: { tasks: Array<{ id: string; description: string; dependsOn: string[]; prompt?: string }> };
      tasks: Array<{ id: string; status: string; attempts: number; valuePreview: string }>;
    };
    expect(payload.originalPrompt).toBe(originalPrompt);
    expect(payload.plan.tasks).toMatchObject([{ id: "worker", description: "Do the work", dependsOn: [] }]);
    expect(payload.plan.tasks[0]).not.toHaveProperty("prompt");
    expect(payload.tasks).toMatchObject([
      { id: "worker", status: "completed", attempts: 1, valuePreview: '"worker result"' },
    ]);
    expect(script).toMatch(/strength: "medium"/u);
    expect(script).toMatch(/strength: "low"/u);
  });

  it("keeps eight large worker values below the managed prompt limit without duplicating outputs", async () => {
    const originalPrompt = `Synthesize all eight workers: ${"p".repeat(30_000)}`;
    const script = buildAdHocWorkflowScript(originalPrompt);
    let synthesizerPrompt = "";
    const taskIds = Array.from({ length: 8 }, (_, index) => `task-${index}`);

    await runWorkflow(script, {
      maxAgents: 10,
      agent: {
        run: async (_prompt: string, options?: AgentRunOptions) => {
          if (options?.label === "planner") {
            return JSON.stringify({
              tasks: taskIds.map((id) => ({
                id,
                description: `Description for ${id}`,
                prompt: `Worker prompt for ${id}`,
                dependsOn: [],
              })),
            });
          }
          if (options?.label === "synthesizer") {
            synthesizerPrompt = _prompt;
            return "bounded final answer";
          }
          return `worker-${options?.label}-value-${"x".repeat(30_000)}`;
        },
      },
    });

    expect(synthesizerPrompt.length).toBeLessThan(100_000);
    const marker = "Original task, execution plan, and graph ledger:\n";
    const payload = JSON.parse(synthesizerPrompt.slice(synthesizerPrompt.indexOf(marker) + marker.length)) as {
      originalPrompt: string;
      originalPromptTruncated: boolean;
      originalPromptTruncationMarker: string | null;
      plan: { tasks: Array<{ id: string; prompt?: string }> };
      tasks: Array<{
        id: string;
        status: string;
        attempts: number;
        error: string | null;
        valuePreview: string;
        valueTruncated: boolean;
        valueTruncationMarker: string | null;
      }>;
      graph?: unknown;
    };
    expect(payload.graph).toBeUndefined();
    expect(payload.originalPrompt).toBe(originalPrompt.slice(0, payload.originalPrompt.length));
    expect(payload.originalPromptTruncated).toBe(true);
    expect(payload.originalPromptTruncationMarker).toMatch(/\[TRUNCATED \d+ SOURCE CHARACTERS\]/u);
    expect(payload.plan.tasks.every((task) => task.prompt === undefined)).toBe(true);
    expect(payload.tasks.map((task) => task.id)).toEqual(taskIds);
    expect(new Set(payload.tasks.map((task) => task.id)).size).toBe(8);
    for (const [index, task] of payload.tasks.entries()) {
      expect(task).toMatchObject({ id: taskIds[index], status: "completed", attempts: 1, error: null });
      expect(task.valueTruncated).toBe(true);
      expect(task.valueTruncationMarker).toMatch(/\[TRUNCATED \d+ SOURCE CHARACTERS\]/u);
      expect(synthesizerPrompt.split(`worker-${task.id}-value-`)).toHaveLength(2);
    }
    expect(script).toMatch(/strength: "medium"/u);
    expect(script).toMatch(/strength: "low"/u);
  });
});
