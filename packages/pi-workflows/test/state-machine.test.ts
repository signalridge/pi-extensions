import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  canTransitionWorkflow,
  transitionTask,
  transitionWorkflow,
  WORKFLOW_STATUSES,
} from "../src/state-machine.js";

describe("workflow state machines", () => {
  it("allows the documented pause and terminal transitions", () => {
    expect(canTransitionWorkflow("running", "pausing")).toBe(true);
    expect(canTransitionWorkflow("pausing", "paused")).toBe(true);
    expect(canTransitionWorkflow("paused", "running")).toBe(true);
    expect(canTransitionTask("queued", "running")).toBe(true);
    expect(canTransitionTask("running", "completed")).toBe(true);
    expect(canTransitionWorkflow("running", "stopping")).toBe(true);
    expect(canTransitionWorkflow("stopping", "failed")).toBe(true);
    expect(canTransitionTask("running", "ready")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransitionWorkflow("completed", "running")).toBe(false);
    expect(() => transitionWorkflow("completed", "running")).toThrow(/invalid workflow/);
    expect(() => transitionTask("completed", "failed")).toThrow(/invalid task/);
    expect(() => transitionWorkflow("completed", "stopping")).toThrow(/invalid workflow/);
  });

  it("enumerates every workflow status", () => {
    expect([...WORKFLOW_STATUSES].sort()).toEqual([
      "completed",
      "failed",
      "interrupted",
      "paused",
      "pausing",
      "pending",
      "running",
      "stopped",
      "stopping",
      "synthesizing",
    ]);
  });
});
