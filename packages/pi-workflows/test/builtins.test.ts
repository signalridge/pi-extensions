import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPT_ARG_KEYS, BUILTIN_WORKFLOWS } from "../src/builtins.js";

/**
 * The failure this guards is silent. A slash command that fills an `args` key
 * its script never reads does not error — the script runs with an empty input
 * and still fans out agents, burning tokens on a review of nothing. So the
 * declared keys are checked against the scripts themselves, not trusted.
 */
function argKeysUsedBy(script: string): string[] {
  return [...new Set(Array.from(script.matchAll(/args\.(\w+)/gu), (m) => m[1]))].sort();
}

describe("builtin workflow argument contract", () => {
  it("declares exactly the arg keys each script reads", () => {
    for (const [name, descriptor] of Object.entries(BUILTIN_WORKFLOWS)) {
      expect(argKeysUsedBy(descriptor.script), `${name} arg keys`).toEqual([...BUILTIN_SCRIPT_ARG_KEYS[name]].sort());
    }
  });

  it("points every primaryArg at a key its own script consumes", () => {
    for (const [name, descriptor] of Object.entries(BUILTIN_WORKFLOWS)) {
      expect(argKeysUsedBy(descriptor.script), `${name}.primaryArg`).toContain(descriptor.primaryArg);
    }
  });

  it("routes each command's free text to the input that command is about", () => {
    expect(BUILTIN_WORKFLOWS["deep-research"].primaryArg).toBe("question");
    expect(BUILTIN_WORKFLOWS["adversarial-review"].primaryArg).toBe("task");
    expect(BUILTIN_WORKFLOWS["code-review"].primaryArg).toBe("diff");
    expect(BUILTIN_WORKFLOWS["multi-perspective"].primaryArg).toBe("topic");
    expect(BUILTIN_WORKFLOWS["codebase-audit"].primaryArg).toBe("scope");
  });

  it("keeps every script parseable as a meta-first module", () => {
    for (const [name, descriptor] of Object.entries(BUILTIN_WORKFLOWS)) {
      expect(descriptor.script.startsWith("export const meta = {"), `${name} starts with meta`).toBe(true);
    }
  });
});
