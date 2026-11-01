/**
 * regular-file.test.ts — agent, memory and skill markdown is read synchronously
 * on the main thread, so a FIFO under one of those names must be skipped, never
 * opened in blocking mode. A blocked read here would wait for a writer that
 * opens two seconds later, so a regression fails on timing and content instead
 * of hanging the test runner.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";
import { safeReadFile } from "../src/memory.js";
import { readRegularFileSync } from "../src/regular-file.js";

describe.skipIf(process.platform === "win32")("markdown reads skip FIFOs without blocking", () => {
  let root: string;
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;
  const writers: number[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "regular-file-"));
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
  });
  afterEach(() => {
    for (const pid of writers.splice(0)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  /** A FIFO whose only writer opens it two seconds from now. */
  function fifo(path: string): void {
    execFileSync("mkfifo", [path]);
    const writer = spawn("sh", ["-c", 'sleep 2; printf LATE > "$1"', "sh", path], { detached: true, stdio: "ignore" });
    writer.unref();
    if (writer.pid) writers.push(writer.pid);
  }

  function timed<T>(read: () => T): { value: T; ms: number } {
    const started = performance.now();
    const value = read();
    return { value, ms: performance.now() - started };
  }

  it("refuses a FIFO and still reads a regular file", () => {
    const pipe = join(root, "pipe.md");
    fifo(pipe);
    const { ms } = timed(() => expect(() => readRegularFileSync(pipe)).toThrow("not a regular file"));
    expect(ms).toBeLessThan(1_000);
    writeFileSync(join(root, "plain.md"), "plain");
    expect(readRegularFileSync(join(root, "plain.md"))).toBe("plain");
  });

  it("skips a FIFO memory or skill file", () => {
    const pipe = join(root, "MEMORY.md");
    fifo(pipe);
    const { value, ms } = timed(() => safeReadFile(pipe));
    expect(value).toBeUndefined();
    expect(ms).toBeLessThan(1_000);
  });

  it("skips a FIFO agent file and loads its neighbours", () => {
    const agents = join(root, ".pi", "agents");
    mkdirSync(agents, { recursive: true });
    fifo(join(agents, "piped.md"));
    writeFileSync(join(agents, "plain.md"), "---\ndescription: plain\n---\n\nPlain agent.");
    const { value, ms } = timed(() => loadCustomAgents(root));
    expect(ms).toBeLessThan(1_000);
    expect(value.has("piped")).toBe(false);
    expect(value.get("plain")?.systemPrompt).toBe("Plain agent.");
  });
});
