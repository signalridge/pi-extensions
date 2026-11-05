// Bootstrap before importing the SDK: no real HOME, credentials, or discovery paths.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [entry, ...args] = process.argv.slice(2);
assert.ok(entry?.startsWith("scripts/"), "expected a repository smoke entrypoint");
// Keep owned paths short (workflow journal paths have a bounded serialized size).
const sandbox = realpathSync(mkdtempSync("/tmp/pi-native-qualification-"));
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  JITI_FS_CACHE: "false",
  JITI_CACHE: "false",
  PI_SMOKE_SANDBOX: sandbox,
  NODE_OPTIONS: `--require=${join(root, "scripts/pi-smoke-guard.cjs")}`,
};
for (const [key, directory] of Object.entries({
  HOME: "home",
  PI_CODING_AGENT_DIR: "agent",
  XDG_CONFIG_HOME: "config",
  XDG_CACHE_HOME: "cache",
  XDG_DATA_HOME: "data",
  TMPDIR: "tmp",
})) {
  env[key] = join(sandbox, directory);
  mkdirSync(env[key], { recursive: true });
}
const child = spawn(process.execPath, [join(root, entry), ...args], {
  cwd: sandbox,
  env,
  stdio: "inherit",
  detached: process.platform !== "win32",
});
function stopOwnedProcesses() {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
const interrupt = () => stopOwnedProcesses();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(status.code, 0, `${entry} failed (${status.signal ?? status.code})`);
} finally {
  stopOwnedProcesses();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
