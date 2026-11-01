import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerRules } from "../src/extension.js";

type Handler = (...args: unknown[]) => unknown;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(mode: "tui" | "rpc" | "print", choose?: (options: string[]) => string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "pi-rules-command-"));
  roots.push(root);
  const rulesDir = join(root, ".pi", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "api.md"), "---\ndescription: API rules\n---\nBody");
  writeFileSync(join(rulesDir, "bad.md"), "---\nquestion: Is it bad?\n---\nBody");
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const notes: { message: string; level: string }[] = [];
  const selects: { title: string; options: string[] }[] = [];
  registerRules(
    {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerTool: () => {},
      registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options.handler),
      appendEntry: () => {},
      sendMessage: () => {},
    } as never,
    { agentDir: () => join(root, "agent") },
  );
  const ctx = {
    cwd: root,
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (message: string, level: string) => notes.push({ message, level }),
      select: async (title: string, options: string[]) => {
        selects.push({ title, options });
        return choose?.(options);
      },
    },
  };
  return {
    notes,
    selects,
    start: () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx),
    run: (args = "") => commands.get("rules")?.(args, ctx),
  };
}

describe("/rules", () => {
  it("warns at startup about rejected files, in every mode that has a UI", () => {
    const h = harness("rpc");
    h.start();
    expect(h.notes).toEqual([
      {
        message: "pi-rules: 1 loaded, 1 rejected. Run /rules for details.",
        level: "warning",
      },
    ]);
  });

  it("reports rules and parse errors as plain text outside the TUI", async () => {
    const h = harness("rpc");
    h.start();
    await h.run();
    expect(h.selects).toEqual([]);
    const report = h.notes.at(-1);
    expect(report?.level).toBe("warning");
    expect(report?.message.split("\n").slice(0, 2)).toEqual([
      "pi-rules: 1 loaded, 1 rejected",
      "- api  index  .pi/rules  (0 matches, 0 delivered)",
    ]);
    expect(report?.message).toContain('bad.md: "question" is not supported: model-judged rules are not supported');
  });

  it("browses rules in the TUI and shows the chosen rule's details", async () => {
    const h = harness("tui", (options) => options[0]);
    h.start();
    await h.run();
    expect(h.selects).toEqual([
      {
        title: "pi-rules: 1 loaded, 1 rejected",
        options: ["api  index  .pi/rules  (0 matches, 0 delivered)", "Full report (1 diagnostics)"],
      },
    ]);
    expect(h.notes.at(-1)?.message).toContain("api (index, .pi/rules)\nFile: ");
  });

  it("shows one rule by name and stays silent without a UI", async () => {
    const rpc = harness("rpc");
    await rpc.run("api");
    expect(rpc.notes.at(-1)?.message).toContain("Description: API rules");
    await rpc.run("missing");
    expect(rpc.notes.at(-1)).toEqual({
      message: 'pi-rules: no loaded rule named "missing"',
      level: "warning",
    });
    const print = harness("print");
    print.start();
    await print.run();
    expect(print.notes).toEqual([]);
  });
});
