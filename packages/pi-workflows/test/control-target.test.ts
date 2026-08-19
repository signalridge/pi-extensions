import { describe, expect, it } from "vitest";
import { resolveControlTarget } from "../src/index.js";

/**
 * `/workflows stop` and `/workflows rm` are destructive: stopping kills the
 * run's owned agents, and `rm` drops the run and its journal. Neither may fall
 * back to "whatever list() returned first" when the user gives no run id.
 */
describe("resolveControlTarget", () => {
  it("refuses an implicit target for the destructive subcommands", () => {
    expect(resolveControlTarget("rm", "", "run-first")).toBe("");
    expect(resolveControlTarget("stop", "", "run-first")).toBe("");
  });

  it("keeps the convenience default for the reversible subcommands", () => {
    expect(resolveControlTarget("pause", "", "run-first")).toBe("run-first");
    expect(resolveControlTarget("resume", "", "run-first")).toBe("run-first");
  });

  it("honours an explicit run id for every subcommand", () => {
    expect(resolveControlTarget("rm", "run-explicit", "run-first")).toBe("run-explicit");
    expect(resolveControlTarget("stop", "run-explicit", "run-first")).toBe("run-explicit");
    expect(resolveControlTarget("pause", "run-explicit", "run-first")).toBe("run-explicit");
    expect(resolveControlTarget("resume", "run-explicit", "run-first")).toBe("run-explicit");
  });

  it("yields the empty string when there is nothing to act on at all", () => {
    expect(resolveControlTarget("pause", "", undefined)).toBe("");
    expect(resolveControlTarget("rm", "", undefined)).toBe("");
  });
});
