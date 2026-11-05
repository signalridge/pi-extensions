import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertReusableWorktree, type WorktreeInfo } from "../src/worktree.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
let directory: string;
let worktree: WorktreeInfo;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-cold-worktree-"));
  worktree = { path: join(directory, "isolated"), workPath: join(directory, "isolated", "package"), repoRoot: join(directory, "base"), baseSha: "abc123", branch: "pi-agent-test" };
  mkdirSync(worktree.workPath, { recursive: true });
  mkdirSync(join(worktree.repoRoot, ".git"), { recursive: true });
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.[0] === "worktree") return Buffer.from(`worktree ${worktree.path}\0HEAD abc123\0detached\0\0`);
    if (args?.[0] === "rev-parse") return Buffer.from(args[1] === "--git-common-dir" ? join(worktree.repoRoot, ".git") : worktree.path);
    if (args?.[0] === "status") return Buffer.from("");
    throw new Error("Unexpected Git mutation");
  });
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("cold continuation isolated checkout admission", () => {
  it("reuses only an existing registered clean checkout, without creating or mutating one", () => {
    expect(() => assertReusableWorktree(worktree)).not.toThrow();
    expect(vi.mocked(execFileSync).mock.calls.map(call => call[1]?.[0])).toEqual(["worktree", "rev-parse", "rev-parse", "rev-parse", "status"]);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual(["worktree", "list", "--porcelain", "-z"]);
  });

  it("refuses a missing original checkout with actionable non-replacement guidance", () => {
    rmSync(worktree.path, { recursive: true });
    expect(() => assertReusableWorktree(worktree)).toThrow(/checkout is missing.*no replacement worktree is created/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("refuses an unknown checkout instead of adopting a same-named directory", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(""));
    expect(() => assertReusableWorktree(worktree)).toThrow(/unknown Git ownership/);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("refuses dirty checkouts without committing, copying or downgrading isolation", () => {
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
      if (args?.[0] === "worktree") return Buffer.from(`worktree ${worktree.path}\0HEAD abc123\0detached\0\0`);
      if (args?.[0] === "rev-parse") return Buffer.from(args[1] === "--git-common-dir" ? join(worktree.repoRoot, ".git") : worktree.path);
      return Buffer.from("?? unpreserved.txt\n");
    });
    expect(() => assertReusableWorktree(worktree)).toThrow(/dirty; preserve and review/);
    expect(vi.mocked(execFileSync).mock.calls).toHaveLength(5);
  });

  it("refuses a replacement repository inside a still-registered old checkout directory", () => {
    vi.mocked(execFileSync).mockImplementation((_command, args, options) => {
      if (args?.[0] === "worktree") return Buffer.from(`worktree ${worktree.path}\0HEAD abc123\0detached\0\0`);
      if (args?.[1] === "--git-common-dir") return Buffer.from(options && typeof options === "object" && "cwd" in options && options.cwd === worktree.repoRoot ? join(worktree.repoRoot, ".git") : worktree.path);
      return Buffer.from(worktree.path);
    });
    expect(() => assertReusableWorktree(worktree)).toThrow(/another Git repository/);
  });

  it("refuses lost work-directory ownership even if a Git registration still exists", () => {
    vi.mocked(execFileSync).mockImplementation((_command, args) => args?.[0] === "worktree"
      ? Buffer.from(`worktree ${worktree.path}\0HEAD abc123\0detached\0\0`) : Buffer.from(worktree.repoRoot));
    expect(() => assertReusableWorktree(worktree)).toThrow(/no longer belongs/);
  });
});
