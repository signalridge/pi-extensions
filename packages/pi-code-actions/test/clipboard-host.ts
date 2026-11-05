import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

// Every utility Pi's clipboard writer may pick on macOS or Linux resolves to a harmless fixture.
const UTILITIES = ["pbcopy", "wl-copy", "xclip", "xsel", "termux-clipboard-set"];
const INTEROP = ["wslpath", "powershell.exe", "clip", "clip.exe"];
const CLEARED = [
  "DISPLAY",
  "TERMUX_VERSION",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "MOSH_CONNECTION",
  "PI_CLIPBOARD_OSC52",
  "WSL_DISTRO_NAME",
  "WSLENV",
  "WT_SESSION",
];

export type FakeUtility = "copy" | "fail" | "stall";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Signal-free existence probe; teardown waits for the SDK to reap its direct child. */
export function nativePidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Route the public SDK writer to harmless, receipt-producing native workers.
 * No native clipboard or OSC 52 is enabled. Ownership cancellation intentionally
 * need not await the SDK, so this fixture independently drains its actual PIDs.
 */
export function fakeClipboard(mode: FakeUtility, runtime = process.execPath) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform has no descriptor");
  const platform = descriptor;
  const directory = mkdtempSync(path.join(tmpdir(), "pi-code-clipboard-"));
  const releaseFile = path.join(directory, "release");
  const lease = path.join(directory, "owner");
  const worker = path.join(directory, "worker.mjs");
  writeFileSync(lease, String(process.pid));
  writeFileSync(worker, readFileSync(new URL("./clipboard-worker.mjs", import.meta.url)));
  for (const utility of UTILITIES) {
    // exec preserves the SDK child's PID/group and leaves no shell descendants.
    writeFileSync(
      path.join(directory, utility),
      `#!/bin/sh\nexec ${quote(runtime)} ${quote(worker)} ${quote(directory)} ${quote(utility)} ${quote(mode)} ${process.pid} "$@"\n`,
      { mode: 0o700 },
    );
  }
  // Pi also detects WSL via /proc/version after the WSL environment is cleared.
  // A failed/timed-out Linux writer must never escape to the Windows clipboard.
  for (const utility of INTEROP) {
    writeFileSync(
      path.join(directory, utility),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(path.join(directory, `blocked-${utility}`))}\nexit 1\n`,
      { mode: 0o700 },
    );
  }
  const saved = new Map<string, string | undefined>();
  for (const key of [...CLEARED, "PATH", "WAYLAND_DISPLAY"]) saved.set(key, process.env[key]);
  for (const key of CLEARED) delete process.env[key];
  // Absolute shell/runtime/ps paths need no inherited executable search route.
  process.env.PATH = directory;
  process.env.WAYLAND_DISPLAY = "pi-code-actions-test";
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  // A missing directory or expired lease makes even an abruptly orphaned worker
  // self-retire. No PID-based signalling or process-name discovery is involved.
  const heartbeat = setInterval(() => {
    if (existsSync(lease)) {
      const now = new Date();
      utimesSync(lease, now, now);
    }
  }, 250);
  heartbeat.unref();
  const observed = new Map<number, { pid: number; started: boolean; completed: boolean }>();
  const writes = new Set<Promise<void>>();
  let restoring: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  let retired = false;

  function receipts() {
    // The SDK owns the ChildProcess handle, not the cancelled action. Observe
    // exact private executable paths too: teardown may beat the startup receipt.
    const table = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    for (const line of table.split("\n")) {
      if (!line.includes(`${directory}${path.sep}`)) continue;
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
      if (pid > 1 && pid !== process.pid && !observed.has(pid)) {
        observed.set(pid, { pid, started: false, completed: false });
      }
    }
    if (existsSync(directory)) {
      for (const name of readdirSync(directory)) {
        const match = /^worker-(\d+)\.started$/.exec(name);
        if (!match) continue;
        const pid = Number(match[1]);
        observed.set(pid, {
          pid,
          started: true,
          completed: existsSync(path.join(directory, `worker-${pid}.completed`)),
        });
      }
    }
    return [...observed.values()];
  }

  function release() {
    if (!retired && existsSync(directory)) writeFileSync(releaseFile, "");
  }

  function restore(): Promise<void> {
    restoring ??= (async () => {
      try {
        release();
        // Let already-queued copySnippet microtasks invoke the public writer
        // before restoring PATH/platform, including immediate assertion failures.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const pending = Promise.allSettled(writes);
        const deadline = Date.now() + 4000;
        while (receipts().some(({ pid }) => nativePidExists(pid))) {
          if (Date.now() >= deadline) throw new Error(`Clipboard fixture children survived teardown: ${directory}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await pending;
      } catch (error) {
        retired = true;
        clearInterval(heartbeat);
        // The SDK retains the mutable process.env object across awaits. A failed
        // PID drain cannot prove direct/untracked SDK fallbacks have finished.
        // Await our tracked promises even on error, but NEVER restore ambient
        // routes or remove private guards on that incomplete ownership proof.
        // This process is quarantined until retirement; cleanup stays rejected.
        await Promise.allSettled(writes);
        throw error;
      }
      retired = true;
      clearInterval(heartbeat);
      Object.defineProperty(process, "platform", platform);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    })();
    return restoring;
  }

  return {
    directory,
    receipts,
    /** Track the real SDK promise separately from an ownership-cancelled action. */
    write(text: string): Promise<void> {
      if (retired) return Promise.reject(new Error("Clipboard fixture is retired"));
      const pending = copyToClipboard(text);
      writes.add(pending);
      // Handle both outcomes without leaving a rejecting cleanup promise.
      void pending.then(
        () => writes.delete(pending),
        () => writes.delete(pending),
      );
      return pending;
    },
    /** Text each fixture utility received on stdin, by utility name. */
    received(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const utility of UTILITIES) {
        const file = path.join(directory, `${utility}.txt`);
        if (existsSync(file)) result[utility] = readFileSync(file, "utf8");
      }
      return result;
    },
    release,
    // A rejected barrier is permanent: only isolated process retirement may
    // end quarantine. Callers must fail the test, not resume ambient SDK work.
    restore,
    dispose(): Promise<void> {
      disposing ??= restore().then(() => {
        // Keep release and completion proof until native PIDs are gone/reaped.
        rmSync(directory, { recursive: true, force: true });
      });
      return disposing;
    },
  };
}
