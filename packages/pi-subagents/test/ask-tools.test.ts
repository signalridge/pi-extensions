/**
 * ask-tools.test.ts — `ask_tools:`, the per-call approval gate.
 *
 * The gate exists to make an unsafe-sometimes tool usable, so the properties
 * that matter are the ones that decide whether it is a real control:
 *
 *  - it fails CLOSED with no approver. Failing open would delete the rule
 *    exactly where it matters most — an unattended run.
 *  - a decline is final and tells the model not to retry, or the model simply
 *    calls again and the prompt becomes a nag.
 *  - an approval lasts the run, for the same reason in reverse: a prompt on
 *    every call trains the user to approve without reading.
 */
import { describe, expect, it, vi } from "vitest";
import { createAskGate } from "../src/ask-tools.js";

const gate = (askTools: string[], confirm?: any) =>
  createAskGate({
    askTools,
    agentLabel: "Reviewer",
    ...(confirm ? { confirm } : {}),
  });

describe("when the gate exists at all", () => {
  it("is not built when the agent declares no ask_tools", () => {
    expect(gate([])).toBeUndefined();
  });

  it("is not built when every entry is blank", () => {
    expect(gate(["", "  "])).toBeUndefined();
  });

  it("is built when at least one tool is named", () => {
    expect(gate(["bash"], vi.fn())).toBeDefined();
  });
});

describe("which calls it gates", () => {
  it("lets an ungated tool through without asking", async () => {
    const confirm = vi.fn(async () => true);
    const check = gate(["bash"], confirm);
    expect(await check?.("read", {})).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("gates the named tool", async () => {
    const confirm = vi.fn(async () => true);
    const check = gate(["bash"], confirm);
    expect(await check?.("bash", { command: "ls" })).toBeUndefined();
    expect(confirm).toHaveBeenCalled();
  });

  it("matches tool names case-insensitively in both directions", async () => {
    const confirm = vi.fn(async () => true);
    const check = gate(["BASH"], confirm);
    await check?.("bash", {});
    expect(confirm).toHaveBeenCalled();
  });

  it("tolerates whitespace around a configured name", async () => {
    const confirm = vi.fn(async () => true);
    const check = gate(["  bash  "], confirm);
    await check?.("bash", {});
    expect(confirm).toHaveBeenCalled();
  });
});

describe("approving and declining", () => {
  it("allows the call when the user agrees", async () => {
    expect(
      await gate(
        ["bash"],
        vi.fn(async () => true),
      )?.("bash", {}),
    ).toBeUndefined();
  });

  it("blocks the call when the user declines", async () => {
    const decision = await gate(
      ["bash"],
      vi.fn(async () => false),
    )?.("bash", {});
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toMatch(/declined/i);
  });

  // Without this the model retries, the user is prompted again, and the gate
  // becomes a loop instead of a decision.
  it("tells the model not to retry a declined call", async () => {
    const decision = await gate(
      ["bash"],
      vi.fn(async () => false),
    )?.("bash", {});
    expect(decision?.reason).toMatch(/do not retry/i);
  });

  it("asks once and remembers an approval for the rest of the run", async () => {
    const confirm = vi.fn(async () => true);
    const check = gate(["bash"], confirm);
    await check?.("bash", {});
    await check?.("bash", {});
    await check?.("bash", {});
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not remember a decline — the next call asks again", async () => {
    const confirm = vi.fn(async () => false);
    const check = gate(["bash"], confirm);
    await check?.("bash", {});
    await check?.("bash", {});
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("remembers each tool separately", async () => {
    const confirm = vi.fn(async () => true);
    const check = gate(["bash", "write"], confirm);
    await check?.("bash", {});
    await check?.("write", {});
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("failing closed", () => {
  // The whole point of the rule is the run nobody is watching.
  it("blocks the call when there is no human to approve", async () => {
    const decision = await gate(["bash"])?.("bash", {});
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toMatch(/no interactive session/i);
  });

  it("says how to resolve it rather than only that it failed", async () => {
    const decision = await gate(["bash"])?.("bash", {});
    expect(decision?.reason).toMatch(/disallowed_tools/);
  });

  it("blocks when the prompt cannot be shown", async () => {
    const confirm = vi.fn(async () => {
      throw new Error("no tty");
    });
    const decision = await gate(["bash"], confirm)?.("bash", {});
    expect(decision?.block).toBe(true);
  });
});

describe("what the user is shown", () => {
  it("names the agent and the tool in the prompt title", async () => {
    const confirm = vi.fn(async () => true);
    await gate(["bash"], confirm)?.("bash", { command: "ls" });
    expect(confirm.mock.calls[0][0]).toContain("Reviewer");
    expect(confirm.mock.calls[0][0]).toContain("bash");
  });

  // The arguments are the thing being approved, so they have to be visible.
  it("shows the call's arguments", async () => {
    const confirm = vi.fn(async () => true);
    await gate(["bash"], confirm)?.("bash", { command: "rm -rf /tmp/x" });
    expect(confirm.mock.calls[0][1]).toContain("rm -rf /tmp/x");
  });

  it("says so plainly when there are no arguments", async () => {
    const confirm = vi.fn(async () => true);
    await gate(["bash"], confirm)?.("bash", undefined);
    expect(confirm.mock.calls[0][1]).toContain("(no arguments)");
  });

  it("bounds a huge argument blob", async () => {
    const confirm = vi.fn(async () => true);
    await gate(["bash"], confirm)?.("bash", { command: "x".repeat(10_000) });
    expect(confirm.mock.calls[0][1].length).toBeLessThan(500);
  });

  it("collapses multi-line arguments to one line", async () => {
    const confirm = vi.fn(async () => true);
    await gate(["bash"], confirm)?.("bash", "line one\nline two");
    expect(confirm.mock.calls[0][1].split("\n")[0]).toContain(
      "line one line two",
    );
  });

  it("survives arguments that cannot be serialized", async () => {
    const confirm = vi.fn(async () => true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await gate(["bash"], confirm)?.("bash", circular);
    expect(confirm.mock.calls[0][1]).toContain("could not be displayed");
  });

  it("neutralizes an escape sequence in the arguments", async () => {
    const confirm = vi.fn(async () => true);
    await gate(["bash"], confirm)?.("bash", { command: "evil[31mred" });
    expect(confirm.mock.calls[0][1]).not.toContain("[");
  });
});
