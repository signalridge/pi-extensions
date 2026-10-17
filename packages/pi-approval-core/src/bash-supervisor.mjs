// One invocation, one POSIX process group. Keeping its leader alive through
// shell exit/drain avoids ever signalling a released/reusable shell PID.
// IPC disconnect also reclaims the group when the host exits or is killed,
// without installing or changing signal handlers in the host.
import { spawn } from "node:child_process";
import { constants } from "node:os";

let started = false;
let finishing = false;
let timeout;
function killGroup() {
  // This process is still the live group leader; never a saved foreign PID.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}
function finish(result) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  if (!process.connected) return killGroup();
  // Deliver the status before killing our own group. Output continues to flow
  // through inherited stdout/stderr, with a bounded drain in the host.
  process.send(result, () => killGroup());
}
process.on("disconnect", killGroup);
process.on("error", killGroup);
process.on("message", (message) => {
  if (message === "cancel") return killGroup();
  if (started || !process.connected) return killGroup();
  started = true;
  const { shell, args, commandTransport, command, cwd, env, seconds } = message;
  try {
    const stdin = commandTransport === "stdin";
    const child = spawn(shell, stdin ? args : [...args, command], {
      cwd,
      env,
      detached: false,
      stdio: [stdin ? "pipe" : "ignore", 1, 2],
      windowsHide: true,
    });
    child.once("error", (error) => finish({ error: error.message }));
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      // Buffered output remains in the host pipe; descendants must not keep
      // it open after the command exits. The host drains it before settling.
      finish({ exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1) });
    });
    if (stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(command);
    }
    if (seconds !== undefined) timeout = setTimeout(() => finish({ error: `timeout:${seconds}` }), seconds * 1000);
  } catch (error) {
    finish({ error: error.message });
  }
});
