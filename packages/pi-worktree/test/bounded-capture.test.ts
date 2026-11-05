import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  addWorktree,
  currentWorktreePath,
  durableRefExists,
  listWorktrees,
  localBranchExists,
  moveWorktree,
  removeWorktree,
  symbolicBranch,
  WorktreeRecoveryError,
  worktreeInventory,
  worktreeStatusOutput,
} from "../src/git.js";
import { runGitInput } from "../src/git-input.ts";
import { removeWorktreeSafely } from "../src/safe-remove.js";

vi.mock("../src/git-input.ts", async (original) => ({
  ...(await original<typeof import("../src/git-input.ts")>()),
  runGitInput: vi.fn(),
}));

const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
  ...overrides,
});

for (const code of [0, 1, 128]) {
  test(`truncation takes precedence over parse/expected failure (exit ${code})`, async () => {
    const pi = { exec: async () => result({ code, truncated: true }) };
    for (const operation of [
      () => currentWorktreePath(pi, "/repo"),
      () => symbolicBranch(pi, "/repo"),
      () => localBranchExists(pi, "/repo", "feature"),
      () => durableRefExists(pi, "/repo", "refs/heads/feature"),
      () => listWorktrees(pi, "/repo"),
      () => worktreeInventory(pi, "/repo"),
      () => worktreeStatusOutput(pi, "/repo"),
    ])
      await assert.rejects(operation(), /output exceeded.*incomplete/u);
    for (const operation of [
      () => addWorktree(pi, "/repo", { path: "/feature", branch: "feature" }),
      () => moveWorktree(pi, "/repo", "/feature", "/quarantine"),
      () => removeWorktree(pi, "/repo", "/feature"),
    ])
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof WorktreeRecoveryError);
        assert.match(error.message, /outcome may already be committed.*Inspect/u);
        assert.doesNotMatch(error.message, /timed out|cancelled/u);
        return true;
      });
  });
}

test("metadata, inventory, and mutation budgets are independent; timeouts are unchanged", async () => {
  const calls: ExecOptions[] = [];
  const pi = {
    exec: async (_command: string, args: string[], options?: ExecOptions) => {
      calls.push(options ?? {});
      return result({ stdout: args[0] === "rev-parse" ? "/repo\n" : "" });
    },
  };
  await currentWorktreePath(pi, "/repo");
  await listWorktrees(pi, "/repo");
  await worktreeInventory(pi, "/repo");
  await worktreeStatusOutput(pi, "/repo");
  await addWorktree(pi, "/repo", { path: "/feature", branch: "feature" });
  assert.deepEqual(
    calls.map(({ maxBuffer }) => maxBuffer),
    [64 * 1024, ...Array(6).fill(8 * 1024 * 1024), 1024 * 1024],
  );
  assert.deepEqual(
    calls.map(({ timeout }) => timeout),
    [...Array(7).fill(15_000), 60_000],
  );
});

for (const failedCommand of ["status", "ls-files", "submodule-status", "submodule-foreach", "config"]) {
  test(`partial ${failedCommand} inventory cannot return a clean result`, async () => {
    const pi = {
      exec: async (_command: string, args: string[]) => {
        const key = args[0] === "submodule" ? `submodule-${args[1]}` : args[0];
        return result({
          stdout: args[0] === "ls-files" && failedCommand === "config" ? "S protected\0" : "",
          truncated: key === failedCommand,
        });
      },
    };
    await assert.rejects(worktreeInventory(pi, "/repo"), /output exceeded/u);
  });
}

for (const truncated of [false, true]) {
  test(`sparse unsupported fallback only accepts complete output (truncated=${truncated})`, async () => {
    const input = vi.mocked(runGitInput).mockResolvedValue(result({ code: 129, truncated }));
    const pi = {
      exec: async (_command: string, args: string[]) =>
        result({
          stdout: args[0] === "ls-files" ? "S protected\0" : args[0] === "config" ? "true\n" : "",
        }),
    };
    if (truncated) await assert.rejects(worktreeInventory(pi, "/repo"), /output exceeded/u);
    else assert.deepEqual(await worktreeInventory(pi, "/repo"), ["index flag skip-worktree: protected"]);
    assert.equal(input.mock.calls.at(-1)?.[5], 8 * 1024 * 1024);
  });
}

test("timeout and cancellation are not reported as output overflow", async () => {
  const pi = { exec: async () => result({ code: 1, killed: true }) };
  await assert.rejects(worktreeInventory(pi, "/repo"), /timed out or was cancelled/u);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    worktreeInventory(
      {
        exec: async () => {
          calls++;
          return result();
        },
      },
      "/repo",
      controller.signal,
    ),
  );
  assert.equal(calls, 0);
});

for (const committed of [false, true]) {
  test(`move overflow retains data without an automatic inverse move (committed=${committed})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-overflow-"));
    const path = join(root, "linked");
    mkdirSync(path);
    writeFileSync(join(path, "data"), "preserve");
    const calls: string[][] = [];
    let validated = false;
    try {
      const pi = {
        exec: async (_command: string, args: string[]) => {
          calls.push(args);
          if (committed) renameSync(args[2], args[3]);
          return result({ truncated: true });
        },
      };
      await assert.rejects(
        removeWorktreeSafely(pi, root, path, undefined, async () => {
          validated = true;
        }),
        (error: unknown) => error instanceof WorktreeRecoveryError && /inspect.*before retrying/u.test(error.message),
      );
      assert.equal(calls.length, 1, "no rollback, inventory, or deletion follows uncertain move");
      assert.equal(validated, false);
      const retained = committed ? calls[0][3] : path;
      assert.equal(existsSync(retained), true);
      assert.equal(readFileSync(join(retained, "data"), "utf8"), "preserve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
