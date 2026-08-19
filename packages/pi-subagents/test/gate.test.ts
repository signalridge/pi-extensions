/**
 * gate.test.ts — `gate:`, the acceptance signal the agent cannot author.
 *
 * Everything here protects one property: a gate verdict must reflect what the
 * command actually did. The failure modes that break it are a gate that could
 * not run being reported as a pass, and a cache hit reporting a stale pass for
 * a workspace that has since changed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGateCache,
  formatGateVerdict,
  runGate,
  workspaceFingerprint,
} from "../src/gate.js";

beforeEach(() => {
  clearGateCache();
});

const exec = (result: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) => vi.fn(async () => result);

describe("runGate", () => {
  it("passes on exit 0", async () => {
    const verdict = await runGate({
      command: "true",
      cwd: "/tmp",
      exec: exec({ exitCode: 0 }),
    });
    expect(verdict.passed).toBe(true);
  });

  it("fails on a non-zero exit", async () => {
    const verdict = await runGate({
      command: "false",
      cwd: "/tmp",
      exec: exec({ exitCode: 1 }),
    });
    expect(verdict.passed).toBe(false);
  });

  it("runs the command in the agent's workspace", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({ command: "bun run check", cwd: "/work/tree", exec: run });
    expect(run.mock.calls[0][2]).toMatchObject({ cwd: "/work/tree" });
  });

  it("runs the command through a shell, so a project's own gate works verbatim", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({
      command: "bun run check && echo ok",
      cwd: "/tmp",
      exec: run,
    });
    expect(run.mock.calls[0][0]).toBe("sh");
    expect(run.mock.calls[0][1]).toEqual(["-c", "bun run check && echo ok"]);
  });

  it("treats an empty command as nothing to check", async () => {
    const run = exec({ exitCode: 1 });
    const verdict = await runGate({ command: "   ", cwd: "/tmp", exec: run });
    expect(verdict.passed).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("merges stdout and stderr, since either may carry the reason", async () => {
    const verdict = await runGate({
      command: "check",
      cwd: "/tmp",
      exec: exec({ exitCode: 1, stdout: "out-line", stderr: "err-line" }),
    });
    expect(verdict.output).toContain("out-line");
    expect(verdict.output).toContain("err-line");
  });

  // A failing command prints its reason last, so the tail is the useful end.
  it("keeps the end of a long output, not the start", async () => {
    const verdict = await runGate({
      command: "check",
      cwd: "/tmp",
      exec: exec({ exitCode: 1, stdout: `${"x".repeat(10_000)}THE-REASON` }),
    });
    expect(verdict.output).toContain("THE-REASON");
    expect(verdict.output).toContain("truncated");
    expect(verdict.output.length).toBeLessThan(5_000);
  });

  // Reporting an infrastructure failure as a pass turns every broken gate into
  // a silent green, which is worse than having no gate.
  it("fails when the command cannot run at all", async () => {
    const verdict = await runGate({
      command: "check",
      cwd: "/tmp",
      exec: vi.fn(async () => {
        throw new Error("spawn ENOENT");
      }),
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.output).toContain("spawn ENOENT");
  });
});

describe("memoization", () => {
  it("reuses a verdict for the same command and workspace state", async () => {
    const run = exec({ exitCode: 0 });
    const args = {
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    };
    const first = await runGate(args);
    const second = await runGate(args);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.passed).toBe(true);
  });

  it("re-runs when the workspace changed", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    });
    await runGate({
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "def",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("re-runs for a different command on the same workspace", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    });
    await runGate({
      command: "test",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Without a fingerprint the workspace state is unknown, and a cache hit on
  // unknown state is exactly how a stale pass gets reported.
  it("never caches when the workspace cannot be fingerprinted", async () => {
    const run = exec({ exitCode: 0 });
    await runGate({ command: "check", cwd: "/tmp", exec: run });
    await runGate({ command: "check", cwd: "/tmp", exec: run });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("caches a failure too, so a fan-out does not re-run a known-bad gate", async () => {
    const run = exec({ exitCode: 1 });
    const args = {
      command: "check",
      cwd: "/tmp",
      exec: run,
      fingerprint: "abc",
    };
    await runGate(args);
    const second = await runGate(args);
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.passed).toBe(false);
    expect(second.cached).toBe(true);
  });
});

describe("workspaceFingerprint", () => {
  const gitExec = (
    responses: Record<string, { stdout?: string; exitCode?: number | null }>,
  ) =>
    vi.fn(
      async (_file: string, args: string[]) =>
        responses[args[0]] ?? { exitCode: 1 },
    );

  it("combines HEAD, status, and the diff", async () => {
    const run = gitExec({
      "rev-parse": { stdout: "sha1", exitCode: 0 },
      status: { stdout: " M a.ts", exitCode: 0 },
      diff: { stdout: "@@ -1 +1 @@", exitCode: 0 },
    });
    expect(await workspaceFingerprint("/tmp", run)).toBeTypeOf("string");
  });

  // `--porcelain` says a file changed, not to what — two different edits to one
  // file would otherwise share a fingerprint and the second would get the
  // first's verdict.
  it("distinguishes two different edits to the same file", async () => {
    const withDiff = (diff: string) =>
      workspaceFingerprint(
        "/tmp",
        gitExec({
          "rev-parse": { stdout: "sha1", exitCode: 0 },
          status: { stdout: " M a.ts", exitCode: 0 },
          diff: { stdout: diff, exitCode: 0 },
        }),
      );
    expect(await withDiff("first change")).not.toBe(
      await withDiff("second change"),
    );
  });

  it("is stable for an identical workspace", async () => {
    const responses = {
      "rev-parse": { stdout: "sha1", exitCode: 0 },
      status: { stdout: "", exitCode: 0 },
      diff: { stdout: "", exitCode: 0 },
    };
    expect(await workspaceFingerprint("/tmp", gitExec(responses))).toBe(
      await workspaceFingerprint("/tmp", gitExec(responses)),
    );
  });

  it("returns undefined outside a git repository, disabling the cache", async () => {
    expect(
      await workspaceFingerprint(
        "/tmp",
        gitExec({ "rev-parse": { exitCode: 128 } }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when git throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("git missing");
    });
    expect(await workspaceFingerprint("/tmp", run)).toBeUndefined();
  });
});

describe("formatGateVerdict", () => {
  it("states the command and the outcome", () => {
    const text = formatGateVerdict("bun run check", {
      passed: false,
      output: "",
      cached: false,
    });
    expect(text).toContain("bun run check");
    expect(text).toContain("FAILED");
  });

  it("includes the output when there is any", () => {
    const text = formatGateVerdict("check", {
      passed: false,
      output: "2 tests failed",
      cached: false,
    });
    expect(text).toContain("2 tests failed");
  });

  // A cached verdict is still a real verdict, but the reader deserves to know
  // the command did not just run.
  it("says when a verdict was reused", () => {
    const text = formatGateVerdict("check", {
      passed: true,
      output: "",
      cached: true,
    });
    expect(text).toMatch(/cached/i);
  });

  it("does not claim a cache on a fresh run", () => {
    const text = formatGateVerdict("check", {
      passed: true,
      output: "",
      cached: false,
    });
    expect(text).not.toMatch(/cached/i);
  });
});
