import { describe, expect, it } from "vitest";
import {
  AUTO_SCOPE_EXCLUSIONS,
  type CommandResult,
  MAX_DIFF_CHARS,
  resolveCodeReviewScope,
} from "../src/code-review-scope.js";

type Call = { file: string; args: string[] };

/** Fake runner: answers from a table keyed on the joined argv, recording calls. */
function runner(table: Record<string, CommandResult>) {
  const calls: Call[] = [];
  const run = (file: string, args: string[]): CommandResult => {
    calls.push({ file, args });
    return table[[file, ...args].join(" ")] ?? { ok: false, stdout: "" };
  };
  return { run, calls };
}

const AUTO = ["git", "diff", "HEAD", "--", ".", ...AUTO_SCOPE_EXCLUSIONS].join(" ");
const BARE = "git diff HEAD";

describe("resolveCodeReviewScope", () => {
  it("reads a numeric argument as a pull request", () => {
    const { run, calls } = runner({ "gh pr diff 42": { ok: true, stdout: "PR DIFF" } });
    const scope = resolveCodeReviewScope("42", run);
    expect(scope.diff).toBe("PR DIFF");
    expect(scope.diffSource).toBe("PR #42");
    expect(calls[0]).toEqual({ file: "gh", args: ["pr", "diff", "42"] });
  });

  it("reads a `..` argument as a revision range", () => {
    const { run, calls } = runner({ "git diff main..HEAD": { ok: true, stdout: "RANGE DIFF" } });
    const scope = resolveCodeReviewScope("main..HEAD", run);
    expect(scope.diff).toBe("RANGE DIFF");
    expect(scope.diffSource).toBe("range main..HEAD");
    expect(calls[0].args).toEqual(["diff", "main..HEAD"]);
  });

  it("reads any other argument as a path", () => {
    const { run, calls } = runner({ "git diff HEAD -- src/api": { ok: true, stdout: "PATH DIFF" } });
    const scope = resolveCodeReviewScope("src/api", run);
    expect(scope.diff).toBe("PATH DIFF");
    expect(scope.diffSource).toBe("path src/api");
    expect(calls[0].args).toEqual(["diff", "HEAD", "--", "src/api"]);
  });

  it("auto-scopes with no argument, excluding generated artifacts", () => {
    const { run, calls } = runner({ [AUTO]: { ok: true, stdout: "AUTO DIFF" } });
    const scope = resolveCodeReviewScope("", run);
    expect(scope.diff).toBe("AUTO DIFF");
    expect(scope.diffSource).toBe("working tree vs HEAD");
    expect(scope.notices).toEqual([]);
    expect(calls[0].args).toContain(":(exclude)**/node_modules/**");
  });

  it("degrades to the bare diff when the auto scope command fails", () => {
    const { run } = runner({ [BARE]: { ok: true, stdout: "BARE DIFF" } });
    const scope = resolveCodeReviewScope("", run);
    expect(scope.diff).toBe("BARE DIFF");
    expect(scope.diffSource).toBe("working tree (unscoped)");
    expect(scope.notices.join(" ")).toContain("Auto-scoped diff failed");
  });

  it("degrades to the bare diff when the exclusions emptied a non-empty diff", () => {
    const { run } = runner({
      [AUTO]: { ok: true, stdout: "   \n" },
      [BARE]: { ok: true, stdout: "LOCKFILE DIFF" },
    });
    const scope = resolveCodeReviewScope("", run);
    expect(scope.diff).toBe("LOCKFILE DIFF");
    expect(scope.notices.join(" ")).toContain("excluded generated artifact");
  });

  it("reports a genuinely clean tree as clean rather than as a degradation", () => {
    const { run } = runner({
      [AUTO]: { ok: true, stdout: "" },
      [BARE]: { ok: true, stdout: "" },
    });
    const scope = resolveCodeReviewScope("", run);
    expect(scope.diff).toBe("");
    expect(scope.notices).toEqual(["No uncommitted changes against HEAD — nothing to review."]);
  });

  it("reports rather than silently reviewing nothing when a scoped command fails", () => {
    const { run } = runner({});
    expect(resolveCodeReviewScope("77", run).notices.join(" ")).toContain("PR #77");
    expect(resolveCodeReviewScope("a..b", run).notices.join(" ")).toContain("a..b");
    expect(resolveCodeReviewScope("src/x", run).notices.join(" ")).toContain("src/x");
  });

  it("truncates an oversized diff and says so", () => {
    const huge = "x".repeat(MAX_DIFF_CHARS + 5_000);
    const { run } = runner({ [AUTO]: { ok: true, stdout: huge } });
    const scope = resolveCodeReviewScope("", run);
    expect(scope.diff.length).toBeLessThan(huge.length);
    expect(scope.diff).toContain("[diff truncated at");
    expect(scope.notices.join(" ")).toContain("truncated");
  });
});
