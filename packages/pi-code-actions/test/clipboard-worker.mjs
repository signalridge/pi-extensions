// Native fixture only: no polling shell, sleep subprocesses, clipboard access, or signals.
import fs from "node:fs";
import path from "node:path";

const [directory, utility, mode, owner] = process.argv.slice(2);
const receipt = path.join(directory, `worker-${process.pid}`);
const lease = path.join(directory, "owner");
const release = path.join(directory, "release");

function ownerIsCurrent() {
  try {
    // A live direct-parent relationship cannot refer to a recycled owner PID.
    // The lease also bounds survival on runtimes that cache process.ppid.
    return (
      process.ppid === Number(owner) &&
      fs.readFileSync(lease, "utf8") === owner &&
      Date.now() - fs.statSync(lease).mtimeMs < 5000
    );
  } catch {
    return false;
  }
}

if (!ownerIsCurrent()) process.exit(0);
fs.writeFileSync(`${receipt}.started`, JSON.stringify({ pid: process.pid, utility, args: process.argv.slice(6) }));
process.on("exit", () => {
  try {
    fs.writeFileSync(`${receipt}.completed`, "done");
  } catch {
    // Directory retirement is itself a stop condition, including abrupt owner exit.
  }
});
let ended = false;
let content = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  content += chunk;
});
process.stdin.on("end", () => {
  if (!ownerIsCurrent()) process.exit(0);
  fs.writeFileSync(path.join(directory, `${utility}.txt`), content);
  ended = true;
  if (mode !== "stall") process.exit(mode === "fail" ? 1 : 0);
});
setInterval(() => {
  // Missing release proof must never mean "keep polling forever" after retirement.
  if (!ownerIsCurrent() || (ended && fs.existsSync(release))) process.exit(0);
}, 50);
