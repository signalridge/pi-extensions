import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { mapBounded } from "./async-work.js";
import { parseGitStatusZ, parseNumstatZ, stripPathPrefix } from "./git.js";
import type { DiffStats } from "./types.js";

const GIT_QUERY_CONCURRENCY = 4;
const GIT_MAX_BUFFER = 1024 * 1024;

export interface GitMetadata {
  repo: boolean;
  status: Map<string, string>;
  stats: Map<string, DiffStats>;
  branch: string;
  files: string[];
}

class GitQueryError extends Error {
  constructor(
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super("Git metadata query failed");
  }
}

/** Resolve once per browser; never invoke a shell or rely on a later PATH lookup. */
export async function resolveGitExecutable(signal?: AbortSignal): Promise<string> {
  const windows = process.platform === "win32";
  // Batch files require a shell; Git for Windows supplies git.exe.
  const extensions = windows ? [".COM", ".EXE"] : [""];
  const directories = (process.env.PATH ?? "").split(delimiter);
  if (windows) directories.unshift(process.cwd());
  for (const rawDirectory of directories) {
    const directory =
      windows && rawDirectory.startsWith('"') && rawDirectory.endsWith('"') ? rawDirectory.slice(1, -1) : rawDirectory;
    for (const extension of extensions) {
      signal?.throwIfAborted();
      const path = resolve(join(directory, `git${extension}`));
      try {
        await access(path, windows ? constants.F_OK : constants.X_OK);
        signal?.throwIfAborted();
        const info = await stat(path);
        signal?.throwIfAborted();
        if (info.isFile()) return path;
      } catch {}
    }
  }
  signal?.throwIfAborted();
  throw new Error("Git executable not found");
}

/** Reuse only after direct-child termination; inherited pipes do not own the pump. */
function runGit(
  executable: string,
  cwd: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let terminated = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) {
        // Only our read ends: descendants are neither signalled nor awaited.
        // This is safe only after exit/close (or confirmed failure to spawn).
        if (!child.stdout.destroyed) child.stdout.destroy();
        if (!child.stderr.destroyed) child.stderr.destroy();
        reject(failure);
      } else if (code !== 0) reject(new GitQueryError(code, Buffer.concat(stderr).toString("utf8")));
      else resolveResult(Buffer.concat(stdout).toString("utf8"));
    };
    const stop = (error: Error): void => {
      if (settled) return;
      failure ??= error;
      if (terminated) finish(null);
      else {
        // kill(true), kill(false), and kill errors prove nothing about exit.
        // Retain ownership and the caller's generation fence until confirmation.
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const abort = () => stop(new Error("Git metadata cancelled"));
    const timer = setTimeout(() => stop(new Error("Git metadata timed out")), timeout);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > GIT_MAX_BUFFER) stop(new Error("Git metadata output exceeded limit"));
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      failure ??= error;
      // A failed spawn has no direct child. Errors from a live child's kill do
      // not establish termination and must not release a query slot.
      if (child.pid === undefined) {
        terminated = true;
        finish(null);
      }
    });
    child.on("exit", () => {
      terminated = true;
      if (failure) finish(null);
      // Successful output still drains normally, bounded by the same deadline.
    });
    child.on("close", (code) => {
      terminated = true;
      finish(code);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Atomic snapshot: failure/overflow never masquerades as an empty, clean result. */
export async function readGitMetadata(cwd: string, executable: string, signal: AbortSignal): Promise<GitMetadata> {
  const empty: GitMetadata = { repo: false, status: new Map(), stats: new Map(), branch: "", files: [] };
  let location: string;
  try {
    location = await runGit(executable, cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], signal, 2000);
  } catch (error) {
    if (error instanceof GitQueryError && /not a git repository/iu.test(error.stderr)) return empty;
    throw error;
  }
  if (location.startsWith("false\n")) return empty;
  if (!location.startsWith("true\n")) throw new Error("Invalid Git worktree response");
  const prefix = location.slice(5).replace(/\n$/u, "");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let failure: unknown;
  // status already discovers all untracked paths; ls-files only needs tracked
  // entries. Union status targets so staged deletions and renames remain visible.
  const queries = [
    ["--no-optional-locks", "status", "--porcelain", "-z", "-uall"],
    ["ls-files", "-z"],
    ["branch", "--show-current"],
    ["diff", "--no-ext-diff", "--relative", "--numstat", "-z", "HEAD"],
    ["diff", "--no-ext-diff", "--relative", "--numstat", "-z", "--cached"],
  ];
  try {
    const output = await mapBounded(
      queries,
      GIT_QUERY_CONCURRENCY,
      () => !controller.signal.aborted,
      async (args) => {
        try {
          return await runGit(executable, cwd, args, controller.signal, args[0] === "branch" ? 2000 : 5000);
        } catch (error) {
          // An unborn repository has no HEAD; cached diff still describes its index.
          if (
            args.at(-1) === "HEAD" &&
            error instanceof GitQueryError &&
            /bad revision 'HEAD'|ambiguous argument 'HEAD'/u.test(error.stderr)
          )
            return "";
          failure ??= error;
          controller.abort();
          return "";
        }
      },
    );
    if (failure) throw failure;
    signal.throwIfAborted();
    const status = new Map<string, string>();
    for (const entry of parseGitStatusZ(output[0])) {
      const path = stripPathPrefix(entry.path, prefix);
      if (path) status.set(path, entry.code);
    }
    const files = new Set(output[1].split("\0").filter(Boolean));
    for (const path of status.keys()) files.add(path);
    const stats = parseNumstatZ(output[3]);
    for (const [path, counts] of parseNumstatZ(output[4])) {
      if (!stats.has(path)) stats.set(path, counts);
    }
    return { repo: true, status, stats, branch: output[2].trim(), files: [...files] };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
