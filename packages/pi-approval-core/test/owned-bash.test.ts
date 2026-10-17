import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createApprovalBashOperations, hashBytes } from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "approval-owned-bash-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
function ops(shellPath?: string) {
  return createApprovalBashOperations({
    source: "test",
    toolCallId: "owned",
    inputHash: hashBytes("command"),
    request: async () => {},
    isCurrent: () => true,
    shellPath,
  });
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(cwd: string) {
  for (const name of ["shell.pid", "descendant.pid"]) {
    const pid = Number(await readFile(join(cwd, name), "utf8"));
    await vi.waitFor(() => expect(alive(pid), `${name} ${pid} leaked`).toBe(false), { timeout: 2000 });
  }
}
it("B: abort before dispatch creates no marker and installs no abort listener", async () => {
  const cwd = await directory();
  const abort = new AbortController();
  abort.abort();
  await expect(ops().exec("touch marker", cwd, { signal: abort.signal, onData() {} })).rejects.toThrow(
    /stale|cancelled|aborted/,
  );
  expect(existsSync(join(cwd, "marker"))).toBe(false);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});
it.each(["abort", "timeout", "output-error"])(
  "B: reaps shell and descendants and releases listeners after %s",
  async (mode) => {
    const cwd = await directory();
    const abort = new AbortController();
    const before = ["SIGTERM", "SIGHUP", "SIGINT", "exit"].map((name) => process.listenerCount(name));
    const running = ops().exec(
      "printf '%s' $$ > shell.pid; sleep 30 & printf '%s' $! > descendant.pid; printf ready; wait",
      cwd,
      {
        signal: abort.signal,
        timeout: mode === "timeout" ? 0.1 : undefined,
        onData: () => {
          if (mode === "output-error") throw new Error("owned callback failure");
        },
      },
    );
    const result = running.then(
      () => "completed",
      (error: unknown) => String(error),
    );
    await vi.waitFor(() => expect(existsSync(join(cwd, "descendant.pid"))).toBe(true));
    if (mode === "abort") abort.abort();
    expect(await result).toContain(
      mode === "abort" ? "aborted" : mode === "timeout" ? "timeout:" : "owned callback failure",
    );
    await gone(cwd);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(["SIGTERM", "SIGHUP", "SIGINT", "exit"].map((name) => process.listenerCount(name))).toEqual(before);
  },
);
it("B: normal exit reclaims descendants holding inherited output pipes", async () => {
  const cwd = await directory();
  const start = performance.now();
  expect(
    await ops().exec(
      "printf '%s' $$ > shell.pid; sleep 30 & printf '%s' $! > descendant.pid; printf output; exit 7",
      cwd,
      { onData() {} },
    ),
  ).toEqual({ exitCode: 7 });
  expect(performance.now() - start).toBeLessThan(1500);
  await gone(cwd);
});
it("B: configured shell/argv and supplied/default environments remain exact", async () => {
  const cwd = await directory();
  const shell = join(cwd, "configured-shell");
  await writeFile(shell, '#!/bin/sh\nprintf "%s" "$1" > args\nexec /bin/sh "$@"\n');
  await chmod(shell, 0o700);
  let output = "";
  expect(
    await ops(shell).exec('printf "%s|%s" "$ONLY" "$PATH"', cwd, {
      env: { ONLY: "exact", PATH: "/usr/bin:/bin" },
      onData: (b) => {
        output += b;
      },
    }),
  ).toEqual({ exitCode: 0 });
  expect(output).toBe("exact|/usr/bin:/bin");
  expect(await readFile(join(cwd, "args"), "utf8")).toBe("-c");
  output = "";
  await ops().exec('printf "%s" "$PATH"', cwd, {
    onData: (b) => {
      output += b;
    },
  });
  expect(output.split(":")).toContain(join(getAgentDir(), "bin"));
  await writeFile(shell, "#!/missing/approval-shell-interpreter\n");
  await expect(ops(shell).exec("true", cwd, { onData() {} })).rejects.toThrow(/ENOENT/);
  await expect(ops().exec("true", join(cwd, "missing"), { onData() {} })).rejects.toThrow("Working directory");
  const abort = new AbortController();
  await expect(ops().exec("true", shell, { signal: abort.signal, onData() {} })).rejects.toThrow(/ENOTDIR/);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});
it("B: escaped inherited pipes are bounded without signalling a released PID", async () => {
  const cwd = await directory();
  const abort = new AbortController();
  const script =
    'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:["ignore",1,2]}); require("node:fs").writeFileSync("escaped.pid",String(child.pid)); child.unref();';
  const start = performance.now();
  let escaped: number | undefined;
  try {
    expect(
      await ops().exec(`${JSON.stringify(process.execPath)} -e '${script}'`, cwd, {
        signal: abort.signal,
        onData() {},
      }),
    ).toEqual({ exitCode: 0 });
    escaped = Number(await readFile(join(cwd, "escaped.pid"), "utf8"));
    expect(alive(escaped)).toBe(true); // deliberately outside the owned group
    expect(performance.now() - start).toBeLessThan(1500);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    const kill = vi.spyOn(process, "kill");
    abort.abort();
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  } finally {
    // The fixture owns this deliberately escaped 30-second child, not the backend.
    const pid = escaped ?? Number(await readFile(join(cwd, "escaped.pid"), "utf8").catch(() => "0"));
    if (pid > 0 && alive(pid)) process.kill(-pid, "SIGKILL");
    if (pid > 0) await vi.waitFor(() => expect(alive(pid)).toBe(false));
  }
});
it("B: supervisor transports stdin commands with configured arguments", async () => {
  const cwd = await directory();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/bash-supervisor.mjs", import.meta.url))], {
    cwd,
    env: {},
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "",
    result: unknown;
  child.stdout?.on("data", (b) => {
    output += b;
  });
  child.on("message", (value) => {
    result = value;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.send({
    shell: "/bin/sh",
    args: ["-s"],
    commandTransport: "stdin",
    command: "printf stdin; exit 9",
    cwd,
    env: {},
  });
  await closed;
  expect(output).toBe("stdin");
  expect(result).toEqual({ exitCode: 9 });
});
it.each(["exit", "SIGTERM", "SIGKILL"] as const)(
  "B: host %s closes IPC and reclaims the owned group without host signal handlers",
  async (mode) => {
    const cwd = await directory();
    const host = spawn(process.execPath, [fileURLToPath(new URL("./owned-bash-host.mjs", import.meta.url)), cwd], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "";
    host.stderr?.on("data", (b) => {
      diagnostics += b;
    });
    const closed = new Promise((resolve) => host.once("close", resolve));
    try {
      await vi.waitFor(() => expect(existsSync(join(cwd, "ready")), diagnostics).toBe(true), { timeout: 4000 });
      if (mode === "exit") host.send("exit");
      else host.kill(mode);
      await closed;
      await gone(cwd);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await closed;
    }
  },
  8000,
);
