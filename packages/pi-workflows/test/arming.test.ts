import { describe, expect, it } from "vitest";
import { DEFAULT_TRIGGER_WORD, hasTriggerWord, WORKFLOW_ARMED_DIRECTIVE } from "../src/arming.js";

describe("hasTriggerWord — what counts as typing the word", () => {
  it("arms on the bare word", () => {
    expect(hasTriggerWord("workflow")).toBe(true);
    expect(hasTriggerWord("workflows")).toBe(true);
  });

  it("arms mid-sentence, which is how people actually ask", () => {
    expect(hasTriggerWord("can you run a workflow for this?")).toBe(true);
    expect(hasTriggerWord("use workflows to check every package")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasTriggerWord("WORKFLOW")).toBe(true);
    expect(hasTriggerWord("Workflows please")).toBe(true);
  });

  it("arms next to ordinary punctuation", () => {
    expect(hasTriggerWord("workflows, please")).toBe(true);
    expect(hasTriggerWord("(workflow)")).toBe(true);
    expect(hasTriggerWord("a workflow.")).toBe(true);
  });

  // The whole point of the bounded matcher: this is a repository where people
  // write code ABOUT workflows, and none of these is a request to run one.
  it("does not arm inside an identifier", () => {
    expect(hasTriggerWord("myworkflow")).toBe(false);
    expect(hasTriggerWord("workflow_name")).toBe(false);
    expect(hasTriggerWord("WorkflowEngine")).toBe(false);
    expect(hasTriggerWord("workflowId")).toBe(false);
  });

  it("does not arm inside a path", () => {
    expect(hasTriggerWord("src/workflow-editor.ts")).toBe(false);
    expect(hasTriggerWord("packages/pi-workflows/src/index.ts")).toBe(false);
    expect(hasTriggerWord("open workflow.ts")).toBe(false);
  });

  // A dot is the one boundary character that cannot be decided by itself: it
  // ends a sentence as often as it continues a filename.
  it("tells a sentence-ending dot apart from a filename dot", () => {
    expect(hasTriggerWord("please run a workflow.")).toBe(true);
    expect(hasTriggerWord("I mean workflows. Thanks")).toBe(true);
    expect(hasTriggerWord("workflow.ts")).toBe(false);
    expect(hasTriggerWord("workflow.json is the config")).toBe(false);
    expect(hasTriggerWord(".workflow")).toBe(false);
  });

  it("does not arm inside a kebab-case token or a flag", () => {
    expect(hasTriggerWord("--workflow-id")).toBe(false);
    expect(hasTriggerWord("workflow-run")).toBe(false);
  });

  it("does not arm on a slash command — that path already ran explicitly", () => {
    expect(hasTriggerWord("/workflows")).toBe(false);
    expect(hasTriggerWord("/workflows run something")).toBe(false);
  });

  it("does not arm on unrelated text", () => {
    expect(hasTriggerWord("fix the parser")).toBe(false);
    expect(hasTriggerWord("")).toBe(false);
  });

  describe("with a configured synonym", () => {
    it("arms on the synonym", () => {
      expect(hasTriggerWord("please orchestrate this", "orchestrate")).toBe(true);
    });

    it("stops arming on the default word", () => {
      expect(hasTriggerWord("run a workflow", "orchestrate")).toBe(false);
    });

    it("matches the synonym exactly — only the default word takes a plural", () => {
      expect(hasTriggerWord("orchestrates", "orchestrate")).toBe(false);
      expect(hasTriggerWord("workflows", DEFAULT_TRIGGER_WORD)).toBe(true);
    });

    it("applies the same identifier and path boundaries", () => {
      expect(hasTriggerWord("myorchestrate", "orchestrate")).toBe(false);
      expect(hasTriggerWord("src/orchestrate.ts", "orchestrate")).toBe(false);
    });

    it("treats a regex metacharacter in the synonym as a literal", () => {
      expect(hasTriggerWord("c++ code", "c++")).toBe(true);
      expect(hasTriggerWord("cxx code", "c++")).toBe(false);
    });
  });
});

describe("WORKFLOW_ARMED_DIRECTIVE", () => {
  it("authorizes rather than instructs, so a conversational turn stays conversational", () => {
    expect(WORKFLOW_ARMED_DIRECTIVE).toContain("authorized");
    expect(WORKFLOW_ARMED_DIRECTIVE).toContain("permission, not an instruction");
    expect(WORKFLOW_ARMED_DIRECTIVE).toContain("do not run a workflow");
  });

  it("explains that a background run ending the turn is expected, not a stall", () => {
    expect(WORKFLOW_ARMED_DIRECTIVE).toContain("background");
    expect(WORKFLOW_ARMED_DIRECTIVE).toContain("stall");
  });

  it("is detectable in an already-annotated message, so it cannot stack", () => {
    const armed = `run a workflow\n\n${WORKFLOW_ARMED_DIRECTIVE}`;
    expect(armed.includes(WORKFLOW_ARMED_DIRECTIVE)).toBe(true);
  });
});
