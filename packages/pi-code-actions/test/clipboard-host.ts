import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Every utility Pi's clipboard writer may pick on macOS or Linux resolves to a harmless fixture.
const UTILITIES = ["pbcopy", "wl-copy", "xclip", "xsel", "termux-clipboard-set"];
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

/**
 * Route Pi's real `copyToClipboard` to fixture utilities instead of the system clipboard.
 * The process platform reads as Linux without a display, so pi-tui offers no native
 * clipboard; Pi then spawns `pbcopy` (macOS) or `wl-copy` (Linux, Wayland) from PATH.
 */
export function fakeClipboard(mode: FakeUtility) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-code-clipboard-"));
  const release = path.join(directory, "release");
  for (const utility of UTILITIES) {
    const received = path.join(directory, `${utility}.txt`);
    const body =
      mode === "fail"
        ? "cat > /dev/null\nexit 1\n"
        : mode === "stall"
          ? `cat > ${quote(received)}\nwhile [ ! -e ${quote(release)} ]; do sleep 0.02; done\n`
          : `cat > ${quote(received)}\n`;
    writeFileSync(path.join(directory, utility), `#!/bin/sh\n${body}`, {
      mode: 0o700,
    });
  }
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("process.platform has no descriptor");
  const saved = new Map<string, string | undefined>();
  for (const key of [...CLEARED, "PATH", "WAYLAND_DISPLAY"]) saved.set(key, process.env[key]);
  for (const key of CLEARED) delete process.env[key];
  process.env.PATH = `${directory}${path.delimiter}${saved.get("PATH") ?? ""}`;
  process.env.WAYLAND_DISPLAY = "pi-code-actions-test";
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  let restored = false;
  return {
    /** Text each fixture utility received on stdin, by utility name. */
    received(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const utility of UTILITIES) {
        const file = path.join(directory, `${utility}.txt`);
        if (existsSync(file)) result[utility] = readFileSync(file, "utf8");
      }
      return result;
    },
    release() {
      writeFileSync(release, "");
    },
    restore() {
      if (restored) return;
      restored = true;
      writeFileSync(release, "");
      Object.defineProperty(process, "platform", platform);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    dispose() {
      this.restore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
