import assert from "node:assert/strict";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import githubPr, { runGhPrView } from "../src/github-pr.js";
import { createMockContext, createMockPi } from "./support.js";

const pr = { number: 1, state: "OPEN", url: "https://github.com/owner/repo/pull/1" };
const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  stdout: JSON.stringify(pr),
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
  ...overrides,
});

for (const stage of ["view", "counts"] as const) {
  for (const code of [0, 1]) {
    test(`${stage} truncation with exit ${code} rejects before parse/failure handling`, async () => {
      const calls: ExecOptions[] = [];
      const pi = {
        exec: async (_command: string, _args: string[], options?: ExecOptions) => {
          calls.push(options ?? {});
          if (stage === "view" || calls.length === 2) return result({ stdout: "", truncated: true, code });
          return result();
        },
      };
      await assert.rejects(runGhPrView(pi, "/repo"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /output exceeded.*incomplete/u);
        assert.doesNotMatch(error.message, /parse|timed out|cancelled|not found/u);
        return true;
      });
      assert.equal(calls.length, stage === "view" ? 1 : 2);
      assert.deepEqual(
        calls.map(({ maxBuffer }) => maxBuffer),
        stage === "view" ? [1024 * 1024] : [1024 * 1024, 64 * 1024],
      );
      assert.ok(calls.every(({ timeout }) => timeout === 10_000));
    });
  }
}

test("PR timeout remains distinct from overflow", async () => {
  await assert.rejects(
    runGhPrView({ exec: async () => result({ killed: true, code: 1 }) }, "/repo"),
    /timed out or was cancelled/u,
  );
});

test("truncated HEAD discovery has a separate budget and cannot prevent valid PR refresh", async () => {
  const mock = createMockPi();
  const calls: Array<{ command: string; options?: ExecOptions }> = [];
  Object.assign(mock.rawPi, {
    exec: async (command: string, args: string[], options?: ExecOptions) => {
      calls.push({ command, options });
      if (command === "git") return result({ stdout: "/nonexistent/HEAD", truncated: true });
      return result({
        stdout:
          args[0] === "api"
            ? '{"data":{"repository":{"pullRequest":{"comments":{"totalCount":0},"reviews":{"totalCount":0}}}}}'
            : JSON.stringify(pr),
      });
    },
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo", mode: "tui" });
  try {
    for (const handler of mock.events.get("session_start") ?? []) await handler({}, context.ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls[0].command, "git");
    assert.equal(calls[0].options?.maxBuffer, 16 * 1024);
    assert.equal(calls[0].options?.timeout, 5_000);
    assert.match(context.statuses.get("github-pr") ?? "", /#1/u);
  } finally {
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, context.ctx);
  }
});
