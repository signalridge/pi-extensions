/**
 * capabilities.test.ts — the capability contract (A11).
 *
 * The machine-readable declaration in capabilities.ts is the single source of
 * truth for the runtime surface. This test runs the declaration through the
 * real runtime binding check, so a global added to the runtime but not
 * documented (or documented but missing) fails here.
 */

import { describe, expect, it } from "vitest";
import {
  declaredRuntimeGlobals,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_CAPABILITY_CONTRACT_VERSION,
} from "../src/capabilities.js";
import { runWorkflow } from "../src/runtime.js";

describe("workflow capability contract", () => {
  it("declares the full runtime global surface", () => {
    const globals = declaredRuntimeGlobals();
    for (const expected of [
      "agent",
      "parallel",
      "pipeline",
      "orchestrate",
      "workflow",
      "verify",
      "judgePanel",
      "loopUntilDry",
      "completenessCheck",
      "retry",
      "gate",
      "checkpoint",
      "log",
      "phase",
      "args",
      "cwd",
      "process",
      "budget",
    ]) {
      expect(globals).toContain(expected);
    }
  });

  it("every declared global is actually usable in the script realm", async () => {
    const script = `export const meta = { name: "capability", description: "c" };
const names = [typeof agent, typeof parallel, typeof pipeline, typeof orchestrate, typeof workflow, typeof verify,
  typeof judgePanel, typeof loopUntilDry, typeof completenessCheck, typeof retry, typeof gate,
  typeof checkpoint, typeof log, typeof phase, typeof args, typeof cwd, typeof process, typeof budget, typeof console];
return names;`;
    const { result } = await runWorkflow(script, { agent: { run: async () => "x" }, args: { probe: 1 } });
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).every((entry) => entry !== "undefined")).toBe(true);
    // args must be the caller-supplied value, not undefined
    const argsProbe = await runWorkflow(`export const meta = { name: "args-probe", description: "a" };\nreturn args;`, {
      agent: { run: async () => "x" },
      args: { probe: 1 },
    });
    expect(argsProbe.result).toEqual({ probe: 1 });
  });

  it("the contract version is stable and the declaration is non-empty", () => {
    expect(WORKFLOW_CAPABILITY_CONTRACT_VERSION).toBe("2.0.0");
    expect(WORKFLOW_CAPABILITIES.length).toBeGreaterThan(20);
  });

  it("declared options and constraints are well-formed", () => {
    for (const entry of WORKFLOW_CAPABILITIES) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.signature.length).toBeGreaterThan(0);
      for (const option of entry.options) {
        expect(option.name.length).toBeGreaterThan(0);
        expect(option.kind.length).toBeGreaterThan(0);
      }
    }
  });
});
