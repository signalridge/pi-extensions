import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { readGitStatus } from "../src/git-status.js";
import statusline from "../src/statusline.js";
import { createMockContext, createMockPi } from "./support.js";

const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
  ...overrides,
});

for (const code of [0, 1]) {
  test(`status overflow never parses a clean/partial result (exit ${code})`, async () => {
    const pi = { exec: async () => result({ stdout: "## main\n", truncated: true, code }) };
    assert.equal(await readGitStatus(pi as ExtensionAPI, "/repo"), undefined);
  });
}

for (const rootFailure of ["overflow", "timeout", "nonzero", "throw"] as const) {
  test(`root ${rootFailure} preserves valid independent status`, async () => {
    const calls: ExecOptions[] = [];
    const pi = {
      exec: async (_command: string, args: string[], options?: ExecOptions) => {
        calls.push(options ?? {});
        if (args[0] !== "rev-parse") return result({ stdout: "## main\n M changed\n" });
        if (rootFailure === "throw") throw new Error("root unavailable");
        return result({
          stdout: "/partial/path\n",
          truncated: rootFailure === "overflow",
          killed: rootFailure === "timeout",
          code: rootFailure === "nonzero" ? 1 : 0,
        });
      },
    };
    assert.deepEqual(await readGitStatus(pi as ExtensionAPI, "/repo"), {
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 1,
      untracked: 0,
      conflicts: 0,
    });
    assert.deepEqual(
      calls.map(({ maxBuffer }) => maxBuffer),
      [1024 * 1024, 16 * 1024],
    );
    assert.ok(calls.every(({ timeout }) => timeout === 3_000));
  });
}

test("passive footer clocks and debounce are unrefed but still retire on disposal", async () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const mock = createMockPi();
  Object.assign(mock.rawPi, { exec: async () => result() });
  statusline(mock.pi);
  const context = createMockContext({ mode: "tui" });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
  const factory = context.footer as (...args: unknown[]) => { dispose(): void };
  const footer = factory(
    { requestRender() {} },
    {},
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    },
  );
  try {
    for (const handler of mock.events.get("agent_end") ?? []) await handler({}, context.ctx);
    assert.deepEqual(
      intervals.mock.calls.map(([, delay]) => delay),
      [30_000, 5_000],
    );
    for (const { value } of intervals.mock.results) assert.equal(value.hasRef(), false);
    const debounce = timeouts.mock.results[timeouts.mock.calls.findIndex(([, delay]) => delay === 250)].value;
    assert.equal(debounce.hasRef(), false);
  } finally {
    footer.dispose();
  }
});

test("passive statusline permits natural process exit without session_shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "statusline-natural-exit-"));
  const source = new URL("../src/statusline.ts", import.meta.url).pathname;
  const script = `
    import statusline from ${JSON.stringify(source)};
    const handlers = new Map();
    let factory;
    statusline({
      on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, registerShortcut() {},
      getThinkingLevel() { return 'off'; },
      exec: async () => ({stdout:'',stderr:'',code:0,killed:false,truncated:false})
    });
    const ctx = {mode:'tui',hasUI:true,cwd:${JSON.stringify(root)},
      sessionManager:{getEntries:()=>[],getBranch:()=>[],getLeafId:()=>null},
      ui:{setFooter(fn){factory=fn},setStatus(){},notify(){}}};
    await handlers.get('session_start')({},ctx);
    factory({requestRender(){}},{},{getGitBranch:()=>null,getExtensionStatuses:()=>new Map(),onBranchChange:()=>()=>{}});
    await handlers.get('agent_end')({},ctx);
    console.log('READY');
  `;
  const child = spawn("bun", ["--eval", script], {
    env: { ...process.env, PI_CODING_AGENT_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  let diagnostics = "";
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  // Bound natural exit AFTER installation, independently of SDK import/startup cost.
  child.stdout.on("data", () => {
    if (ready) return;
    ready = true;
    deadline = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, 2_000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(ready, true, diagnostics);
    assert.equal(expired, false, "passive timers must not hold the child after installation");
    assert.equal(status, 0, diagnostics);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
