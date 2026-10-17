import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BashOperations, getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { assertCurrent } from "./contract.js";
import { assertOwnedBashRuntime } from "./local-runtime.js";

/** Owned POSIX local backend; the SDK still owns tool/output/truncation behavior.
 * A short-lived supervisor is the process-group lifetime anchor and IPC orphan
 * reaper. No host signal handlers, private SDK helpers or saved-PID kills.
 */
export function createOwnedLocalBashOperations(isCurrent: () => boolean, shellPath?: string): BashOperations {
  return {
    async exec(command, cwd, execution) {
      assertOwnedBashRuntime();
      const { signal, timeout, onData } = execution;
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647))
        throw new Error("Invalid bash timeout");
      const owner = { signal, isCurrent };
      assertCurrent(owner);
      const shell = getShellConfig(shellPath);
      const env = { ...(execution.env ?? process.env) };
      if (execution.env === undefined) {
        const key = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
        const bin = join(getAgentDir(), "bin");
        const path = env[key] ?? "";
        if (!path.split(delimiter).includes(bin)) env[key] = [bin, path].filter(Boolean).join(delimiter);
      }
      const payload = { ...shell, args: [...shell.args], command, cwd, env, seconds: timeout };
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      // Avoid allocating a supervisor for an owner already lost during CWD IO.
      // User-command dispatch is separately guarded at the synchronous IPC send.
      assertCurrent(owner);
      const child = spawn(process.execPath, [fileURLToPath(new URL("./bash-supervisor.mjs", import.meta.url))], {
        cwd,
        env: {},
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let result: { exitCode?: number; error?: string } | undefined;
        let failure: unknown;
        let settled = false;
        let drain: ReturnType<typeof setTimeout> | undefined;
        const disconnect = () => {
          if (child.connected) child.disconnect();
        };
        const onAbort = () => disconnect(); // supervisor kills only its STILL-OWNED group
        const onDataSafe = (data: Buffer) => {
          if (failure || settled) return;
          try {
            onData(data);
          } catch (error) {
            failure = error instanceof Error ? error : new Error("Bash output callback failed", { cause: error });
            disconnect();
          }
        };
        const onMessage = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          if ("error" in value && typeof value.error === "string") result = { error: value.error };
          else if ("exitCode" in value && typeof value.exitCode === "number") result = { exitCode: value.exitCode };
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(drain);
          signal?.removeEventListener("abort", onAbort);
          child.removeListener("message", onMessage);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.removeListener("close", finish);
          child.stdout?.removeListener("data", onDataSafe);
          child.stderr?.removeListener("data", onDataSafe);
          child.stdout?.destroy();
          child.stderr?.destroy();
          disconnect();
          if (failure) reject(failure);
          else if (signal?.aborted) reject(new Error("aborted"));
          else if (result?.error) reject(new Error(result.error));
          else if (result?.exitCode !== undefined) resolve({ exitCode: result.exitCode });
          else reject(new Error("Owned bash supervisor terminated without a result"));
        };
        const onError = (error: Error) => {
          failure = error;
          disconnect();
          if (!child.pid) finish();
        };
        const onExit = () => {
          // No saved PID remains eligible for signalling after exit. Even
          // descendants that escaped the group cannot hold our pipes forever.
          signal?.removeEventListener("abort", onAbort);
          drain = setTimeout(finish, 250);
        };
        child.on("message", onMessage);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", finish);
        child.stdout?.on("data", onDataSafe);
        child.stderr?.on("data", onDataSafe);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else {
          try {
            assertCurrent(owner); // The helper has not received a user command before this dispatch.
            child.send(payload, (error) => {
              if (error) onError(error);
            });
          } catch (error) {
            onError(error instanceof Error ? error : new Error("Bash IPC dispatch failed", { cause: error }));
          }
        }
      });
    },
  };
}
